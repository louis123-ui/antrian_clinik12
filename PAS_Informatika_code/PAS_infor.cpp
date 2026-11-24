#include <cctype>
#include <utility>

#include <cstdlib>
#include <filesystem>
#include <system_error>
#include <fstream>
#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#endif
#include "httplib.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <map>
#include <mutex>
#include <random>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace fs = std::filesystem;
using SteadyClock = std::chrono::steady_clock;

namespace {
constexpr int kMinNumber = 1, kMaxNumber = 9999;
constexpr size_t kCodeLength = 6;
const auto kSessionLifetime = std::chrono::hours(12);
const std::string kAttUnknown = "belum_konfirmasi";
const std::string kAttOnSite = "di_area";
const std::string kAttOnTheWay = "perjalanan";
const std::string kAttCannotCome = "tidak_datang";
const std::string kWaiting = "menunggu";
const std::string kCalled = "dipanggil";
const std::string kServing = "dilayani";
const std::string kDone = "selesai";
const std::string kExpired = "hangus";
const std::string kCodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

long long nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(
        system_clock::now().time_since_epoch()).count();
}

std::string envOr(const char* name, const std::string& fallback) {
    const char* v = std::getenv(name);
    return (v && *v) ? std::string(v) : fallback;
}

struct QueueEntry {
    int number = 0;
    std::string code;
    std::string attendance = kAttUnknown;
    long long attendanceUpdatedAt = 0;
    std::string callStatus = kWaiting;
    int callCount = 0;
    long long callId = 0, calledAt = 0, firstCalledAt = 0;
    long long deadlineAt = 0, createdAt = 0, updatedAt = 0;
};

struct Limiter {
    struct Slot {
        int failures = 0;
        SteadyClock::time_point windowStart{}, lockedUntil{};
    };

    int maxFailures;
    std::chrono::seconds lockFor;
    std::unordered_map<std::string, Slot> slots;

    Limiter(int max, std::chrono::seconds lock)
        : maxFailures(max), lockFor(lock) {}

    long long lockedSeconds(const std::string& ip) {
        auto it = slots.find(ip);
        if (it == slots.end()) return 0;

        auto now = SteadyClock::now();
        if (it->second.lockedUntil > now)
            return std::chrono::duration_cast<std::chrono::seconds>(
                it->second.lockedUntil - now).count() + 1;

        return 0;
    }

    bool fail(const std::string& ip) {
        auto& s = slots[ip];
        auto now = SteadyClock::now();

        if (now - s.windowStart > lockFor) {
            s.failures = 0;
            s.windowStart = now;
        }

        if (++s.failures >= maxFailures) {
            s.failures = 0;
            s.lockedUntil = now + lockFor;
            return true;
        }
        return false;
    }

    void success(const std::string& ip) {
        slots.erase(ip);
    }

    void prune() {
        auto now = SteadyClock::now();
        for (auto it = slots.begin(); it != slots.end();) {
            if (it->second.lockedUntil < now &&
                now - it->second.windowStart > lockFor)
                it = slots.erase(it);
            else
                ++it;
        }
    }
};

std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);

    for (unsigned char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else out.push_back(static_cast<char>(c));
        }
    }
    return out;
}

bool extractJsonString(const std::string& json,
                       const std::string& key, std::string& out) {
    const std::string pattern = "\"" + key + "\"";
    size_t pos = json.find(pattern);
    if (pos == std::string::npos) return false;

    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return false;

    pos = json.find_first_not_of(" \t\r\n", pos + 1);
    if (pos == std::string::npos || json[pos] != '"') return false;

    ++pos;
    std::string val;

    while (pos < json.size()) {
        char c = json[pos++];

        if (c == '\\' && pos < json.size()) {
            char next = json[pos++];
            if (next == '"' || next == '\\' || next == '/')
                val.push_back(next);
            else if (next == 'n') val.push_back('\n');
            else if (next == 'r') val.push_back('\r');
            else if (next == 't') val.push_back('\t');
        } else if (c == '"') {
            out = val;
            return true;
        } else val.push_back(c);
    }
    return false;
}

bool extractJsonInt(const std::string& json,
                    const std::string& key, long long& out) {
    const std::string pattern = "\"" + key + "\"";
    size_t pos = json.find(pattern);
    if (pos == std::string::npos) return false;

    pos = json.find(':', pos + pattern.size());
    if (pos == std::string::npos) return false;

    pos = json.find_first_not_of(" \t\r\n", pos + 1);
    if (pos == std::string::npos) return false;

    bool quoted = json[pos] == '"';
    if (quoted) ++pos;

    size_t end = pos;
    while (end < json.size() &&
           std::isdigit(static_cast<unsigned char>(json[end]))) ++end;

    if (end == pos || end - pos > 9) return false;
    if (quoted && (end >= json.size() || json[end] != '"')) return false;

    out = std::stoll(json.substr(pos, end - pos));
    return true;
}

void securityHeaders(httplib::Response& res) {
    res.set_header("X-Content-Type-Options", "nosniff");
    res.set_header("Referrer-Policy", "no-referrer");
    res.set_header("X-Frame-Options", "DENY");
}

void sendJson(httplib::Response& res, int code,
              const std::string& body) {
    res.status = code;
    res.set_header("Cache-Control", "no-store");
    securityHeaders(res);
    res.set_content(body, "application/json; charset=utf-8");
}

void sendError(httplib::Response& res, int code,
               const std::string& message) {
    sendJson(res, code,
        "{\"ok\":false,\"error\":\"" + jsonEscape(message) + "\"}");
}

std::string contentTypeFor(const fs::path& p) {
    const std::string ext = p.extension().string();

    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".js") return "application/javascript; charset=utf-8";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".ico") return "image/x-icon";

    return "application/octet-stream";
}

bool safeFileName(const std::string& name) {
    if (name.empty() || name.size() > 64 ||
        name.find("..") != std::string::npos) return false;

    return std::all_of(name.begin(), name.end(),
        [](unsigned char c) {
            return std::isalnum(c) || c == '.' || c == '-' || c == '_';
        });
}

bool constantTimeEquals(const std::string& a, const std::string& b) {
    unsigned char diff = static_cast<unsigned char>(a.size() != b.size());
    size_t n = std::max(a.size(), b.size());

    for (size_t i = 0; i < n; ++i) {
        unsigned char ca = i < a.size() ? a[i] : 0;
        unsigned char cb = i < b.size() ? b[i] : 0;
        diff |= ca ^ cb;
    }
    return diff == 0;
}

std::random_device& rng() {
    static std::random_device rd;
    return rd;
}

std::string randomHex(int bytes) {
    static const char* hex = "0123456789abcdef";
    std::string s;

    for (int i = 0; i < bytes; ++i) {
        unsigned v = rng()() & 0xFFu;
        s.push_back(hex[v >> 4]);
        s.push_back(hex[v & 0xF]);
    }
    return s;
}

std::string randomCode() {
    std::uniform_int_distribution<size_t> pick(
        0, kCodeAlphabet.size() - 1);

    std::string s;
    for (size_t i = 0; i < kCodeLength; ++i)
        s.push_back(kCodeAlphabet[pick(rng())]);

    return s;
}

std::string normalizeCode(const std::string& raw) {
    std::string out;

    for (unsigned char c : raw) {
        if (c == ' ' || c == '-') continue;
        out.push_back(static_cast<char>(std::toupper(c)));
    }
    return out;
}

bool validNumber(long long n) {
    return n >= kMinNumber && n <= kMaxNumber;
}

std::string bearerToken(const httplib::Request& req) {
    if (!req.has_header("Authorization")) return {};

    const std::string h = req.get_header_value("Authorization");
    const std::string prefix = "Bearer ";

    if (h.size() > prefix.size() &&
        h.compare(0, prefix.size(), prefix) == 0)
        return h.substr(prefix.size());

    return {};
}

std::string clientIp(const httplib::Request& req) {
    return req.remote_addr.empty() ? "127.0.0.1" : req.remote_addr;
}

std::string waitText(long long seconds) {
    return seconds >= 60
        ? std::to_string((seconds + 59) / 60) + " menit"
        : std::to_string(seconds) + " detik";
}

class QueueServer {
public:
    QueueServer(std::string adminPassword, fs::path webRoot,
                long long lateMs)
        : adminPassword_(std::move(adminPassword)),
          webRoot_(std::move(webRoot)), lateMs_(lateMs) {}

    void registerRoutes(httplib::Server& svr);

    void tick() {
        std::lock_guard<std::recursive_mutex> lock(mtx_);
        const long long now = nowMs();

        for (auto& [num, e] : entries_) {
            if (e.callStatus == kCalled &&
                e.deadlineAt > 0 && now >= e.deadlineAt) {
                e.callStatus = kExpired;
                e.updatedAt = now;
            }
        }

        if (++tickCount_ % 300 == 0) {
            patientLimiter_.prune();
            adminLimiter_.prune();
        }
    }

private:
    std::string commonFieldsJson(const QueueEntry& e) const {
        std::ostringstream ss;

        ss << "\"number\":" << e.number
           << ",\"attendance\":\"" << jsonEscape(e.attendance) << "\""
           << ",\"attendanceUpdatedAt\":" << e.attendanceUpdatedAt
           << ",\"callStatus\":\"" << jsonEscape(e.callStatus) << "\""
           << ",\"callCount\":" << e.callCount
           << ",\"callId\":" << e.callId
           << ",\"calledAt\":" << e.calledAt
           << ",\"firstCalledAt\":" << e.firstCalledAt
           << ",\"deadlineAt\":" << e.deadlineAt
           << ",\"createdAt\":" << e.createdAt
           << ",\"updatedAt\":" << e.updatedAt;

        return ss.str();
    }

    std::string patientStateJsonLocked(const QueueEntry& e) const {
        int ahead = 0;

        if (e.callStatus == kWaiting) {
            for (const auto& [num, other] : entries_) {
                if (num >= e.number) break;
                if (other.callStatus == kWaiting) ++ahead;
            }
        }

        std::ostringstream ss;
        ss << "{" << commonFieldsJson(e)
           << ",\"aheadCount\":" << ahead
           << ",\"lastCalledNumber\":" << lastCalledNumber_
           << ",\"lateMs\":" << lateMs_
           << ",\"bootId\":\"" << jsonEscape(bootId_) << "\""
           << ",\"serverTime\":" << nowMs() << "}";

        return ss.str();
    }

    std::string adminSnapshotJsonLocked() const {
        std::ostringstream ss;
        ss << "{\"ok\":true,\"type\":\"queue\",\"entries\":[";

        bool first = true;
        for (const auto& [num, e] : entries_) {
            if (!first) ss << ",";
            first = false;

            ss << "{" << commonFieldsJson(e)
               << ",\"code\":\"" << jsonEscape(e.code) << "\"}";
        }

        ss << "],\"lastCalledNumber\":" << lastCalledNumber_
           << ",\"lateMs\":" << lateMs_
           << ",\"serverTime\":" << nowMs() << "}";

        return ss.str();
    }

    bool tokenValidLocked(const std::string& token) {
        if (token.empty()) return false;

        const auto now = SteadyClock::now();
        for (auto it = tokens_.begin(); it != tokens_.end();) {
            if (it->second <= now) it = tokens_.erase(it);
            else ++it;
        }

        return tokens_.find(token) != tokens_.end();
    }

    bool isAdmin(const httplib::Request& req) {
        std::lock_guard<std::recursive_mutex> lock(mtx_);
        return tokenValidLocked(bearerToken(req));
    }

    QueueEntry* checkTicketLocked(const std::string& ip,
        long long number, const std::string& rawCode,
        httplib::Response& res) {

        const long long locked = patientLimiter_.lockedSeconds(ip);

        if (locked) {
            sendError(res, 429,
                "Terlalu banyak percobaan salah. Coba lagi dalam " +
                waitText(locked) + ".");
            return nullptr;
        }

        const std::string code = normalizeCode(rawCode);

        if (!validNumber(number) || code.size() != kCodeLength) {
            sendError(res, 400,
                "Nomor antrean harus angka 1 sampai 9999 dan kode karcis 6 huruf/angka.");
            return nullptr;
        }

        auto it = entries_.find(static_cast<int>(number));

        if (it == entries_.end() ||
            !constantTimeEquals(code, it->second.code)) {

            const bool nowLocked = patientLimiter_.fail(ip);

            sendError(res, nowLocked ? 429 : 403,
                nowLocked
                    ? "Terlalu banyak percobaan salah. Coba lagi dalam " +
                      waitText(patientLimiter_.lockFor.count()) + "."
                    : "Nomor antrean atau kode karcis salah. Periksa kembali karcis Anda atau tanyakan kepada petugas.");

            return nullptr;
        }

        patientLimiter_.success(ip);
        return &it->second;
    }

    bool serveStaticFile(const fs::path& filename,
                         httplib::Response& res) {
        std::vector<fs::path> paths = {
            webRoot_ / filename,
            webRoot_ / "public" / filename,
            webRoot_ / "assets" / filename
        };

        for (const auto& full : paths) {
            std::error_code ec;

            if (fs::exists(full, ec) &&
                fs::is_regular_file(full, ec)) {

                std::ifstream in(full, std::ios::binary);
                if (!in) continue;

                std::ostringstream ss;
                ss << in.rdbuf();

                res.status = 200;
                res.set_header("Cache-Control", "no-cache");
                securityHeaders(res);
                res.set_content(ss.str(), contentTypeFor(full));
                return true;
            }
        }
        return false;
    }

    void handleAdminAction(const httplib::Request& req,
        httplib::Response& res, int number,
        const std::string& action) {

        if (!isAdmin(req)) {
            sendError(res, 401,
                "Sesi dokter tidak valid. Silakan masuk lagi.");
            return;
        }

        std::lock_guard<std::recursive_mutex> lock(mtx_);
        auto it = entries_.find(number);
        const std::string label = "Nomor " + std::to_string(number);

        if (it == entries_.end()) {
            sendError(res, 404, label + " tidak terdaftar.");
            return;
        }

        QueueEntry& e = it->second;
        const long long now = nowMs();
        std::string done;

        if (action == "call") {
            if (e.callStatus != kWaiting && e.callStatus != kCalled) {
                sendError(res, 409,
                    label + " berstatus " + e.callStatus +
                    " dan tidak bisa dipanggil.");
                return;
            }

            const bool first = e.callStatus == kWaiting;

            if (first) {
                e.firstCalledAt = now;
                e.deadlineAt = now + lateMs_;
            }

            e.callStatus = kCalled;
            ++e.callCount;
            e.callId = ++callSeq_;
            e.calledAt = now;
            lastCalledNumber_ = number;

            done = first ? "dipanggil" :
                "dipanggil ulang (batas waktu tidak bertambah)";

        } else if (action == "hadir") {
            if (e.callStatus != kCalled) {
                sendError(res, 409,
                    label + " tidak sedang dipanggil atau waktunya sudah habis.");
                return;
            }

            e.callStatus = kServing;
            done = "ditandai hadir";

        } else if (action == "selesai") {
            if (e.callStatus != kServing && e.callStatus != kCalled) {
                sendError(res, 409, label + " belum dilayani.");
                return;
            }

            e.callStatus = kDone;
            done = "ditandai selesai";

        } else if (action == "aktifkan") {
            if (e.callStatus != kExpired) {
                sendError(res, 409, label + " tidak berstatus hangus.");
                return;
            }

            e.callStatus = kWaiting;
            e.firstCalledAt = 0;
            e.deadlineAt = 0;
            done = "diaktifkan lagi";

        } else if (action == "hapus") {
            entries_.erase(it);
            sendJson(res, 200,
                "{\"ok\":true,\"message\":\"" +
                jsonEscape(label + " dihapus.") + "\"}");
            return;

        } else {
            sendError(res, 404, "Aksi tidak dikenal.");
            return;
        }

        e.updatedAt = now;

        sendJson(res, 200,
            "{\"ok\":true,\"message\":\"" +
            jsonEscape(label + " " + done + ".") + "\"}");
    }

    std::string adminPassword_;
    fs::path webRoot_;
    long long lateMs_;
    const std::string bootId_ = randomHex(6);
    std::recursive_mutex mtx_;
    std::map<int, QueueEntry> entries_;
    long long callSeq_ = 0;
    int lastCalledNumber_ = 0;
    long long tickCount_ = 0;
    std::unordered_map<std::string, SteadyClock::time_point> tokens_;
    Limiter adminLimiter_{5, std::chrono::seconds(300)};
    Limiter patientLimiter_{10, std::chrono::seconds(120)};
};

void QueueServer::registerRoutes(httplib::Server& svr) {
    svr.Get("/", [this](const httplib::Request&, httplib::Response& res) {
        if (!serveStaticFile("PAS_infor_pasien.html", res) &&
            !serveStaticFile("index.html", res)) {
            res.status = 404;
            res.set_content(
                "File PAS_infor_pasien.html tidak ditemukan di folder proyek.",
                "text/plain");
        }
    });

    auto serveDoctorPage = [this](const httplib::Request&,
                                  httplib::Response& res) {
        if (!serveStaticFile("PAS_infor_dokter.html", res) &&
            !serveStaticFile("admin.html", res)) {
            res.status = 404;
            res.set_content(
                "File PAS_infor_dokter.html tidak ditemukan di folder proyek.",
                "text/plain");
        }
    };

    svr.Get("/dokter", serveDoctorPage);
    svr.Get("/admin", serveDoctorPage);

    svr.Get("/healthz", [](const httplib::Request&,
                           httplib::Response& res) {
        res.set_content("ok", "text/plain");
    });

    svr.Post("/api/patient/open",
        [this](const httplib::Request& req, httplib::Response& res) {
            long long number = 0;
            std::string code;

            if (!extractJsonInt(req.body, "number", number) ||
                !extractJsonString(req.body, "code", code)) {
                sendError(res, 400,
                    "Masukkan nomor antrean dan kode karcis.");
                return;
            }

            std::lock_guard<std::recursive_mutex> lock(mtx_);
            QueueEntry* e = checkTicketLocked(
                clientIp(req), number, code, res);

            if (!e) return;

            sendJson(res, 200,
                "{\"ok\":true,\"entry\":" +
                patientStateJsonLocked(*e) + "}");
        });

    svr.Get("/api/patient/state",
        [this](const httplib::Request& req, httplib::Response& res) {
            if (!req.has_param("number") || !req.has_param("code")) {
                sendError(res, 400,
                    "Parameter number dan code wajib diisi.");
                return;
            }

            long long number = 0;

            try {
                number = std::stoll(req.get_param_value("number"));
            } catch (...) {
                sendError(res, 400, "Nomor tidak valid.");
                return;
            }

            std::string code = req.get_param_value("code");
            std::lock_guard<std::recursive_mutex> lock(mtx_);

            QueueEntry* e = checkTicketLocked(
                clientIp(req), number, code, res);

            if (!e) return;

            sendJson(res, 200,
                "{\"ok\":true,\"entry\":" +
                patientStateJsonLocked(*e) + "}");
        });

    svr.Post("/api/patient/attendance",
        [this](const httplib::Request& req, httplib::Response& res) {
            long long number = 0;
            std::string code, status;

            if (!extractJsonInt(req.body, "number", number) ||
                !extractJsonString(req.body, "code", code) ||
                !extractJsonString(req.body, "status", status)) {
                sendError(res, 400, "Format permintaan tidak valid.");
                return;
            }

            if (status != kAttOnSite &&
                status != kAttOnTheWay &&
                status != kAttCannotCome) {
                sendError(res, 400,
                    "Status kehadiran tidak dikenal.");
                return;
            }

            std::lock_guard<std::recursive_mutex> lock(mtx_);
            QueueEntry* e = checkTicketLocked(
                clientIp(req), number, code, res);

            if (!e) return;

            if (e->callStatus != kWaiting &&
                e->callStatus != kCalled) {
                sendError(res, 409,
                    "Antrean Anda berstatus " + e->callStatus +
                    ", status kehadiran tidak dapat diubah.");
                return;
            }

            const long long now = nowMs();
            e->attendance = status;
            e->attendanceUpdatedAt = now;
            e->updatedAt = now;

            sendJson(res, 200,
                "{\"ok\":true,\"entry\":" +
                patientStateJsonLocked(*e) + "}");
        });

    svr.Post("/api/admin/login",
        [this](const httplib::Request& req, httplib::Response& res) {
            const std::string ip = clientIp(req);
            std::lock_guard<std::recursive_mutex> lock(mtx_);

            if (const long long s = adminLimiter_.lockedSeconds(ip)) {
                sendError(res, 429,
                    "Kata sandi salah terlalu sering. Coba lagi dalam " +
                    waitText(s) + ".");
                return;
            }

            std::string password;

            if (!extractJsonString(req.body, "password", password)) {
                sendError(res, 400,
                    "Format permintaan tidak valid.");
                return;
            }

            if (!constantTimeEquals(password, adminPassword_)) {
                const bool locked = adminLimiter_.fail(ip);

                sendError(res, locked ? 429 : 401,
                    locked
                        ? "Kata sandi salah 5 kali. Login dikunci 5 menit."
                        : "Kata sandi salah.");
                return;
            }

            adminLimiter_.success(ip);
            const std::string token = randomHex(24);
            tokens_[token] = SteadyClock::now() + kSessionLifetime;

            sendJson(res, 200,
                "{\"ok\":true,\"token\":\"" + token + "\"}");
        });

    svr.Post("/api/admin/logout",
        [this](const httplib::Request& req, httplib::Response& res) {
            std::lock_guard<std::recursive_mutex> lock(mtx_);
            tokens_.erase(bearerToken(req));
            sendJson(res, 200, "{\"ok\":true}");
        });

    svr.Get("/api/admin/queue",
        [this](const httplib::Request& req, httplib::Response& res) {
            if (!isAdmin(req)) {
                sendError(res, 401,
                    "Sesi dokter tidak valid. Silakan masuk lagi.");
                return;
            }

            std::lock_guard<std::recursive_mutex> lock(mtx_);
            sendJson(res, 200, adminSnapshotJsonLocked());
        });

    svr.Post("/api/admin/queue",
        [this](const httplib::Request& req, httplib::Response& res) {
            if (!isAdmin(req)) {
                sendError(res, 401,
                    "Sesi dokter tidak valid. Silakan masuk lagi.");
                return;
            }

            long long number = 0;

            if (!extractJsonInt(req.body, "number", number)) {
                sendError(res, 400,
                    "Nomor antrean harus berupa angka.");
                return;
            }

            if (!validNumber(number)) {
                sendError(res, 400,
                    "Nomor antrean harus angka 1 sampai 9999.");
                return;
            }

            std::lock_guard<std::recursive_mutex> lock(mtx_);

            if (entries_.count(static_cast<int>(number))) {
                sendError(res, 409,
                    "Nomor " + std::to_string(number) +
                    " sudah ada. Hapus dulu jika ingin membuat karcis baru.");
                return;
            }

            QueueEntry e;
            e.number = static_cast<int>(number);
            e.code = randomCode();
            e.createdAt = e.updatedAt = nowMs();
            entries_[e.number] = e;

            sendJson(res, 201,
                "{\"ok\":true,\"number\":" +
                std::to_string(e.number) +
                ",\"code\":\"" + e.code + "\"}");
        });

    svr.Post(R"(/api/admin/queue/(\d+)/([a-z]+))",
        [this](const httplib::Request& req, httplib::Response& res) {
            int n = std::stoi(req.matches[1]);
            std::string action = req.matches[2];
            handleAdminAction(req, res, n, action);
        });

    svr.Get(R"(/assets/([A-Za-z0-9._-]+))",
        [this](const httplib::Request& req, httplib::Response& res) {
            std::string name = req.matches[1];

            if (!safeFileName(name) || !serveStaticFile(name, res)) {
                res.status = 404;
                res.set_content("File tidak ditemukan", "text/plain");
            }
        });

    svr.Get(R"(/([A-Za-z0-9._-]+))",
        [this](const httplib::Request& req, httplib::Response& res) {
            std::string name = req.matches[1];

            if (!safeFileName(name) || !serveStaticFile(name, res)) {
                res.status = 404;
                res.set_content("File tidak ditemukan", "text/plain");
            }
        });
}
}

int main() {
    const std::string password =
        envOr("ADMIN_PASSWORD", "admin123");

    int port = std::atoi(envOr("PORT", "8080").c_str());
    if (port <= 0 || port >= 65536) port = 8080;

    long long lateMinutes =
        std::atoll(envOr("LATE_MINUTES", "10").c_str());
    if (lateMinutes < 1 || lateMinutes > 120) lateMinutes = 10;

    std::error_code ec;
    fs::path webRoot = fs::current_path(ec);

    QueueServer server(password, webRoot, lateMinutes * 60 * 1000);
    httplib::Server svr;
    server.registerRoutes(svr);

    std::atomic<bool> running{true};

    std::thread ticker([&] {
        while (running) {
            std::this_thread::sleep_for(std::chrono::seconds(1));
            server.tick();
        }
    });

    std::cout
        << "==============================================\n"
        << "Server antrean aktif!\n"
        << "  Halaman Pasien : http://localhost:" << port << "/\n"
        << "  Halaman Dokter : http://localhost:" << port << "/dokter\n"
        << "  Sandi Dokter   : " << password << "\n"
        << "Tekan Ctrl+C untuk berhenti.\n"
        << "==============================================\n";

    if (!svr.listen("0.0.0.0", port))
        std::cerr << "Gagal menjalankan server di port "
                  << port << ".\n";

    running = false;
    ticker.join();

    return 0;
}
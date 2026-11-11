#pragma once

#include <cstdint>
#include <cstring>
#include <sodium.h>
#include <string>
#include <vector>

#ifndef _WIN32
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

// Persistent compiled-kernel cache. Entries hold only public kernel code: search
// secrets live in device buffers and never reach the compiler. Keys hash the
// complete kernel source, build options, runtime, driver and device identity.
// Every entry carries a BLAKE2b checksum; anything unreadable, foreign-owned,
// writable by others or corrupt is ignored and rebuilt. Writes are atomic.
class KernelCache {
public:
  KernelCache(const std::string &directory, const std::string &identity) {
    if (directory.empty() || directory[0] != '/' || directory.size() > 3072)
      return;
    unsigned char key[32];
    crypto_generichash(key, sizeof(key),
                       reinterpret_cast<const unsigned char *>(identity.data()),
                       identity.size(), nullptr, 0);
    std::memcpy(this->key, key, sizeof(key));
    char name[65];
    sodium_bin2hex(name, sizeof(name), key, sizeof(key));
    this->directory = directory;
    path = directory + "/" + name + ".bin";
  }

  bool load(std::vector<unsigned char> &binary) const {
#ifdef _WIN32
    return false;
#else
    if (path.empty() || !privateDirectory(directory))
      return false;
    int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0)
      return false;
    std::vector<unsigned char> data;
    struct stat info;
    bool valid = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
                 info.st_uid == geteuid() && !(info.st_mode & (S_IWGRP | S_IWOTH)) &&
                 info.st_size > off_t(header) && info.st_size <= off_t(limit);
    if (valid) {
      data.resize(size_t(info.st_size));
      valid = readAll(fd, data.data(), data.size());
    }
    close(fd);
    if (!valid || std::memcmp(data.data(), magic, sizeof(magic)) != 0)
      return false;
    unsigned char digest[32];
    checksum(digest, data.data() + header, data.size() - header);
    if (sodium_memcmp(digest, data.data() + sizeof(magic), sizeof(digest)) != 0)
      return false;
    binary.assign(data.begin() + header, data.end());
    return true;
#endif
  }

  // Best effort: a read-only or missing cache directory only costs compile time.
  void store(const std::vector<unsigned char> &binary) const noexcept {
#ifndef _WIN32
    if (path.empty() || binary.empty() || binary.size() > limit - header)
      return;
    try {
      if (!makeDirectories(directory))
        return;
      unsigned char nonce[8];
      randombytes_buf(nonce, sizeof(nonce));
      char suffix[17];
      sodium_bin2hex(suffix, sizeof(suffix), nonce, sizeof(nonce));
      const std::string temporary = path + ".tmp-" + suffix;
      int fd = open(temporary.c_str(),
                    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
      if (fd < 0)
        return;
      std::vector<unsigned char> data(header + binary.size());
      std::memcpy(data.data(), magic, sizeof(magic));
      checksum(data.data() + sizeof(magic), binary.data(), binary.size());
      std::memcpy(data.data() + header, binary.data(), binary.size());
      bool written = writeAll(fd, data.data(), data.size());
      written = close(fd) == 0 && written;
      if (!written || rename(temporary.c_str(), path.c_str()) != 0)
        unlink(temporary.c_str());
    } catch (...) {
    }
#else
    (void)binary;
#endif
  }

private:
  static constexpr char magic[8] = {'P', 'V', 'K', 'K', 'E', 'R', 'N', '2'};
  static constexpr size_t header = sizeof(magic) + 32;
  static constexpr size_t limit = size_t(64) << 20;
  std::string directory, path;
  unsigned char key[32] = {};

  // Keyed by the entry's identity hash, so a valid entry renamed over another
  // key's file fails verification instead of loading for the wrong device/mode.
  void checksum(unsigned char digest[32], const unsigned char *data, size_t size) const {
    crypto_generichash(digest, 32, data, size, key, sizeof(key));
  }

#ifndef _WIN32
  static bool readAll(int fd, unsigned char *data, size_t size) {
    while (size) {
      ssize_t n = read(fd, data, size);
      if (n < 0 && errno == EINTR)
        continue;
      if (n <= 0)
        return false;
      data += n;
      size -= size_t(n);
    }
    return true;
  }

  static bool writeAll(int fd, const unsigned char *data, size_t size) {
    while (size) {
      ssize_t n = write(fd, data, size);
      if (n < 0 && errno == EINTR)
        continue;
      if (n <= 0)
        return false;
      data += n;
      size -= size_t(n);
    }
    return true;
  }

  // Creates missing components with owner-only permissions. Existing
  // components are left alone, but the final directory must belong to us.
  static bool makeDirectories(const std::string &directory) {
    for (size_t i = 1; i <= directory.size(); i++) {
      if (i != directory.size() && directory[i] != '/')
        continue;
      const std::string component = directory.substr(0, i);
      if (mkdir(component.c_str(), 0700) != 0 && errno != EEXIST)
        return false;
    }
    return privateDirectory(directory);
  }

  static bool privateDirectory(const std::string &directory) {
    struct stat info;
    return lstat(directory.c_str(), &info) == 0 && S_ISDIR(info.st_mode) &&
           info.st_uid == geteuid() && !(info.st_mode & (S_IWGRP | S_IWOTH));
  }
#endif
};

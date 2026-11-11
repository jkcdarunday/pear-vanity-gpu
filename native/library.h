#pragma once

#include <initializer_list>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

// GPU runtimes are loaded on demand so the addon itself only depends on the C
// library. A missing runtime becomes an ordinary backend error and lets the
// JavaScript layer fall back. Runtimes are never unloaded: drivers commonly
// register process-exit handlers and keep internal threads alive. Bare names
// use the platform loader's system search path (on Linux, never the working
// directory); macOS names are absolute because dyld may fall back to it.
class Library {
public:
  Library(std::initializer_list<const char *> names, const char *description) {
    for (auto name : names) {
#ifdef _WIN32
      // Never search the current directory for GPU runtimes.
      handle = reinterpret_cast<void *>(
          LoadLibraryExA(name, nullptr, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS));
#else
      handle = dlopen(name, RTLD_NOW | RTLD_LOCAL);
#endif
      if (handle)
        return;
    }
    throw std::runtime_error(std::string(description) + " runtime is not installed");
  }

  Library(const Library &) = delete;
  Library &operator=(const Library &) = delete;

  void *find(const char *name) const {
#ifdef _WIN32
    return reinterpret_cast<void *>(
        GetProcAddress(reinterpret_cast<HMODULE>(handle), name));
#else
    return dlsym(handle, name);
#endif
  }

  template <typename T> void load(T &function, const char *name) const {
    function = reinterpret_cast<T>(find(name));
    if (!function)
      throw std::runtime_error(std::string("GPU runtime is missing ") + name);
  }

private:
  void *handle = nullptr;
};

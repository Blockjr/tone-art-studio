#include <windows.h>
#include <olectl.h>

#include <new>
#include <string>
#include <vector>

#include "VirtualAsioDriver.h"
#include "VirtualAsioIds.h"

namespace
{
HINSTANCE moduleInstance = nullptr;
LONG lockCount = 0;

std::wstring guidToString (REFCLSID clsid)
{
    wchar_t buffer[64] {};
    StringFromGUID2 (clsid, buffer, 64);
    return buffer;
}

bool writeValue (HKEY root, const std::wstring& subKey, const wchar_t* valueName, const std::wstring& value)
{
    HKEY key = nullptr;

    if (RegCreateKeyExW (root, subKey.c_str(), 0, nullptr, REG_OPTION_NON_VOLATILE,
                         KEY_WRITE | KEY_WOW64_64KEY, nullptr, &key, nullptr) != ERROR_SUCCESS)
        return false;

    const auto bytes = (DWORD) ((value.size() + 1) * sizeof (wchar_t));
    const auto result = RegSetValueExW (key, valueName, 0, REG_SZ,
                                        reinterpret_cast<const BYTE*> (value.c_str()), bytes);

    RegCloseKey (key);
    return result == ERROR_SUCCESS;
}

bool deleteKey (HKEY root, const std::wstring& subKey)
{
    return RegDeleteTreeW (root, subKey.c_str()) == ERROR_SUCCESS;
}

std::wstring modulePath()
{
    std::vector<wchar_t> buffer (MAX_PATH * 4);

    while (true)
    {
        const auto length = GetModuleFileNameW (moduleInstance, buffer.data(), (DWORD) buffer.size());

        if (length == 0)
            return {};

        if (length < buffer.size() - 1)
            return std::wstring (buffer.data(), length);

        buffer.resize (buffer.size() * 2);
    }
}
} // namespace

//==============================================================================
class HybridAsioFactory final : public IClassFactory
{
public:
    HRESULT STDMETHODCALLTYPE QueryInterface (REFIID iid, void** object) override
    {
        if (object == nullptr)
            return E_POINTER;

        *object = nullptr;

        if (iid == __uuidof (IUnknown) || iid == __uuidof (IClassFactory))
        {
            *object = static_cast<IClassFactory*> (this);
            return S_OK;
        }

        return E_NOINTERFACE;
    }

    ULONG STDMETHODCALLTYPE AddRef() override   { return 2; }
    ULONG STDMETHODCALLTYPE Release() override  { return 1; }

    HRESULT STDMETHODCALLTYPE CreateInstance (IUnknown* outer, REFIID iid, void** object) override
    {
        if (object == nullptr)
            return E_POINTER;

        if (outer != nullptr)
            return CLASS_E_NOAGGREGATION;

        auto* driver = new (std::nothrow) HybridVirtualDriver();

        if (driver == nullptr)
            return E_OUTOFMEMORY;

        const auto result = driver->QueryInterface (iid, object);
        driver->Release();
        return result;
    }

    HRESULT STDMETHODCALLTYPE LockServer (BOOL lock) override
    {
        lock != FALSE ? InterlockedIncrement (&lockCount) : InterlockedDecrement (&lockCount);
        return S_OK;
    }

    // Public: DllGetClassObject owns a function-local static factory, and its
    // destructor has to be reachable from there.
    ~HybridAsioFactory() = default;
};

//==============================================================================
// The four entry points are exported through VirtualAsio.def. Defining them with
// the SDK's own STDAPI macro keeps the signature identical to the declaration
// olectl.h already made, so there is no linkage clash to fight.
STDAPI DllGetClassObject (REFCLSID clsid, REFIID iid, void** object)
{
    if (object == nullptr)
        return E_POINTER;

    *object = nullptr;

    if (! IsEqualGUID (clsid, hybridVirtualAsioClsid))
        return CLASS_E_CLASSNOTAVAILABLE;

    static HybridAsioFactory factory;
    return factory.QueryInterface (iid, object);
}

STDAPI DllCanUnloadNow()
{
    return lockCount == 0 ? S_OK : S_FALSE;
}

STDAPI DllRegisterServer()
{
    const auto path = modulePath();

    if (path.empty())
        return SELFREG_E_CLASS;

    const auto clsid = guidToString (hybridVirtualAsioClsid);
    const auto processed = L"Software\\Classes\\CLSID\\" + clsid;

    if (! writeValue (HKEY_LOCAL_MACHINE, processed, nullptr, hybridVirtualAsioName))
        return SELFREG_E_CLASS;

    writeValue (HKEY_LOCAL_MACHINE, processed + L"\\InprocServer32", nullptr, path);
    writeValue (HKEY_LOCAL_MACHINE, processed + L"\\InprocServer32", L"ThreadingModel", L"Both");

    // The key ASIO hosts enumerate.
    const std::wstring asioKey = L"SOFTWARE\\ASIO\\" + std::wstring (hybridVirtualAsioName);

    if (! writeValue (HKEY_LOCAL_MACHINE, asioKey, L"CLSID", clsid))
        return SELFREG_E_CLASS;

    writeValue (HKEY_LOCAL_MACHINE, asioKey, L"Description", hybridVirtualAsioDescription);

    return S_OK;
}

STDAPI DllUnregisterServer()
{
    const auto clsid = guidToString (hybridVirtualAsioClsid);

    deleteKey (HKEY_LOCAL_MACHINE, L"SOFTWARE\\ASIO\\" + std::wstring (hybridVirtualAsioName));
    deleteKey (HKEY_LOCAL_MACHINE, L"Software\\Classes\\CLSID\\" + clsid);

    return S_OK;
}

//==============================================================================
BOOL APIENTRY DllMain (HMODULE instance, DWORD reason, LPVOID)
{
    if (reason == DLL_PROCESS_ATTACH)
    {
        moduleInstance = instance;
        DisableThreadLibraryCalls (instance);
    }

    return TRUE;
}

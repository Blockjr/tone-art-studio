#pragma once

#include <guiddef.h>

/**
    {6E1B7A52-2C4E-4B0E-9F1B-7A3C5D8E9F21}

    ASIO hosts create the driver with CoCreateInstance(clsid, ..., clsid, ...),
    i.e. they pass the class id as the interface id, so QueryInterface must accept
    this GUID as well as IID_IUnknown.
*/
inline const CLSID hybridVirtualAsioClsid =
    { 0x6e1b7a52, 0x2c4e, 0x4b0e, { 0x9f, 0x1b, 0x7a, 0x3c, 0x5d, 0x8e, 0x9f, 0x21 } };

inline constexpr wchar_t hybridVirtualAsioName[] = L"Tone Art Virtual ASIO";
inline constexpr wchar_t hybridVirtualAsioDescription[] =
    L"Tone Art Virtual ASIO (2 in / 2 out loopback)";

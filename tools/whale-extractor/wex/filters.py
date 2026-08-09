"""CEX / contract / burn filters + address normalize / dedupe."""
from __future__ import annotations

import re
from typing import Iterable

# Known CEX / burn / token contracts — always skip for whale lists
KNOWN_SKIP = {
    "0x28c6c06298d514db089934071355e5743bf21d60",
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549",
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d",
    "0x56eddb7aa87536c09ccc2793473599fd21a8b17f",
    "0x9696f59e4d72e237be84ffd425dcad154bf96976",
    "0x0681d8db095565fe8a346fa0277bffde9c0edbbf",
    "0xfe9e8709d3215310075d67e3ed32a380ccf451c8",
    "0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67",
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3",
    "0xa7efae728d2936e78bda97dc267687568dd593f3",
    "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8",
    "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be",
    "0xd551234ae421e3bcba99a0da6d736074f22192ff",
    "0x564286362092d8e7936f0549571a803b203aaced",
    "0x2b5634c42055806a59e9107ed44d43c426e58258",
    "0x689c56aef474df92d44a1b70850f808488f9769c",
    "0xa1d8d972560c2f8144af871db508f0b0b10a3fbf",
    "0xeb2629a2734e272bcc07bda959863f316f4bd4cf",
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3",
    "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43",
    "0x77696bb39917c91a0c3d2f8c0b49d641b8d8b4b9",
    "0x6cc5f688a315f3dc28a7781717a9a798a59fd9da",
    "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3",
    "0xf89d7b9c864f589bbf53a82105107622b35eaa40",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    "0x0000000000000000000000000000000000000000",
    "0x000000000000000000000000000000000000dead",
    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "0xdac17f958d2ee523a2206206994597c13d831ec7",
    "0x6b175474e89094c44da98b954eedeac495271d0f",
    "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
    "0x514910771af9ca656af840dff83e8264ecf986ca",
}

_EVM_RE = re.compile(r"^0x[a-fA-F0-9]{40}$")


def normalize_evm(addr: str) -> str | None:
    a = (addr or "").strip().lower()
    if not _EVM_RE.match(a):
        return None
    return a


def is_skipped_address(addr: str) -> bool:
    n = normalize_evm(addr)
    if not n:
        return True
    return n in KNOWN_SKIP


def dedupe_addresses(addrs: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in addrs:
        n = normalize_evm(raw)
        if not n or n in seen or is_skipped_address(n):
            continue
        seen.add(n)
        out.append(n)
    return out

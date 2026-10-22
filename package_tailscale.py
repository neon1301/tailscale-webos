#!/usr/bin/env python3
"""
Packaging script for Tailscale on LG webOS.
Downloads official Tailscale ARM binaries if missing and creates a standalone .ipk.
"""

import os
import sys
import io
import time
import tarfile
import urllib.request
import json
import shutil

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(ROOT_DIR, "tailscale_build")
BIN_DIR = os.path.join(BUILD_DIR, "service", "bin")

def ensure_binaries():
    ts_bin = os.path.join(BIN_DIR, "tailscale")
    tsd_bin = os.path.join(BIN_DIR, "tailscaled")

    if os.path.exists(ts_bin) and os.path.exists(tsd_bin):
        print("[*] Official Tailscale binaries present in service/bin.")
        return

    print("[*] Tailscale binaries not found. Downloading latest stable ARM package from pkgs.tailscale.com...")
    url = "https://pkgs.tailscale.com/stable/tailscale_latest_arm.tgz"
    tmp_tgz = os.path.join(ROOT_DIR, "tailscale_latest_arm.tgz")

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp, open(tmp_tgz, "wb") as f:
        shutil.copyfileobj(resp, f)

    print(f"[*] Downloaded {os.path.getsize(tmp_tgz)} bytes. Extracting ARM binaries...")
    with tarfile.open(tmp_tgz, "r:gz") as tar:
        for member in tar.getmembers():
            if member.name.endswith("/tailscale") or member.name.endswith("/tailscaled"):
                fname = os.path.basename(member.name)
                dest = os.path.join(BIN_DIR, fname)
                print(f"    -> Extracting {fname} to {dest}")
                with tar.extractfile(member) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                os.chmod(dest, 0o755)

    if os.path.exists(tmp_tgz):
        os.remove(tmp_tgz)
    print("[*] Binaries ready.")

def build_ipk():
    ensure_binaries()

    appinfo_path = os.path.join(BUILD_DIR, "app", "appinfo.json")
    with open(appinfo_path, "r", encoding="utf-8") as f:
        appinfo = json.load(f)

    pkg_id = appinfo.get("id", "com.tailscale.webos")
    pkg_ver = appinfo.get("version", "1.104.2")
    out_ipk = os.path.join(ROOT_DIR, f"{pkg_id}_{pkg_ver}_all.ipk")

    print(f"[*] Building {pkg_id} v{pkg_ver} -> {os.path.basename(out_ipk)}...")

    # 1. debian-binary
    deb_binary = b"2.0\n"

    # 2. control.tar.gz
    control_content = f"""Package: {pkg_id}
Version: {pkg_ver}
Section: misc
Priority: optional
Architecture: all
Installed-Size: 62914560
Maintainer: Tailscale on webOS Contributors
Description: Official Tailscale client for LG webOS TV (Userspace networking, remote control UI, background service, autostart & self-updater).
webOS-Package-Format-Version: 2
webOS-Packager-Version: 1.0.0
""".encode("utf-8")

    control_bio = io.BytesIO()
    with tarfile.open(fileobj=control_bio, mode="w:gz") as tar:
        ti = tarfile.TarInfo("control")
        ti.size = len(control_content)
        ti.mtime = int(time.time())
        ti.mode = 0o644
        tar.addfile(ti, io.BytesIO(control_content))
    control_data = control_bio.getvalue()

    # 3. data.tar.gz
    data_bio = io.BytesIO()
    with tarfile.open(fileobj=data_bio, mode="w:gz") as tar:
        def add_tree(src_dir, dest_prefix):
            for root, dirs, files in os.walk(src_dir):
                rel_dir = os.path.relpath(root, src_dir)
                archive_dir = os.path.normpath(os.path.join(dest_prefix, rel_dir)).replace("\\", "/")
                if archive_dir != ".":
                    di = tarfile.TarInfo(archive_dir)
                    di.type = tarfile.DIRTYPE
                    di.mode = 0o755
                    di.mtime = int(time.time())
                    tar.addfile(di)

                for file in files:
                    if file == ".gitkeep":
                        continue
                    file_path = os.path.join(root, file)
                    arcname = os.path.normpath(os.path.join(archive_dir, file)).replace("\\", "/")
                    fi = tarfile.TarInfo(arcname)
                    fi.size = os.path.getsize(file_path)
                    fi.mtime = int(os.path.getmtime(file_path))
                    if file in ["tailscale", "tailscaled"] or file.endswith(".sh"):
                        fi.mode = 0o755
                    else:
                        fi.mode = 0o644

                    with open(file_path, "rb") as f:
                        tar.addfile(fi, f)

        add_tree(os.path.join(BUILD_DIR, "app"), f"usr/palm/applications/{pkg_id}")
        add_tree(os.path.join(BUILD_DIR, "service"), f"usr/palm/services/{pkg_id}.service")
        add_tree(os.path.join(BUILD_DIR, "pkg"), f"usr/palm/packages/{pkg_id}")

    data_bytes = data_bio.getvalue()

    # 4. Assemble AR archive
    def ar_header(name, size):
        name_field = f"{name:<16}"[:16]
        mtime_field = f"{int(time.time()):<12}"[:12]
        owner_field = f"{0:<6}"[:6]
        group_field = f"{0:<6}"[:6]
        mode_field = f"{'100644':<8}"[:8]
        size_field = f"{size:<10}"[:10]
        fmag = "`\n"
        return (name_field + mtime_field + owner_field + group_field + mode_field + size_field + fmag).encode("ascii")

    with open(out_ipk, "wb") as f:
        f.write(b"!<arch>\n")
        f.write(ar_header("debian-binary", len(deb_binary)))
        f.write(deb_binary)
        if len(deb_binary) % 2 == 1:
            f.write(b"\n")

        f.write(ar_header("control.tar.gz", len(control_data)))
        f.write(control_data)
        if len(control_data) % 2 == 1:
            f.write(b"\n")

        f.write(ar_header("data.tar.gz", len(data_bytes)))
        f.write(data_bytes)
        if len(data_bytes) % 2 == 1:
            f.write(b"\n")

    print(f"[+] Successfully built: {out_ipk} ({os.path.getsize(out_ipk):,} bytes)")

if __name__ == "__main__":
    build_ipk()

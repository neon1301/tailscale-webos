import tarfile
import io
import os
import time

build_dir = r'E:\TV\tailscale_build'
out_ipk = r'E:\TV\com.tailscale.webos_1.104.8_all.ipk'

# 1. debian-binary
deb_binary = b'2.0\n'

# 2. control.tar.gz
control_content = b'''Package: com.tailscale.webos
Version: 1.104.8
Section: misc
Priority: optional
Architecture: all
Installed-Size: 52428800
Maintainer: Tailscale webOS Community
Description: Tailscale for LG webOS (Userspace Networking & Proxy)
webOS-Package-Format-Version: 2
webOS-Packager-Version: 1.0.0
'''

control_bio = io.BytesIO()
with tarfile.open(fileobj=control_bio, mode='w:gz') as tar:
    ti = tarfile.TarInfo('control')
    ti.size = len(control_content)
    ti.mtime = int(time.time())
    ti.mode = 0o644
    tar.addfile(ti, io.BytesIO(control_content))

control_data = control_bio.getvalue()

# 3. data.tar.gz
data_bio = io.BytesIO()
with tarfile.open(fileobj=data_bio, mode='w:gz') as tar:
    def add_dir(name):
        ti = tarfile.TarInfo(name)
        ti.type = tarfile.DIRTYPE
        ti.mode = 0o777
        ti.uid = 1001
        ti.gid = 1001
        ti.uname = 'developer'
        ti.gname = 'developer'
        ti.mtime = int(time.time())
        tar.addfile(ti)

    add_dir('usr')
    add_dir('usr/palm')
    add_dir('usr/palm/applications')
    add_dir('usr/palm/packages')
    add_dir('usr/palm/services')

    # Add app
    app_base = 'usr/palm/applications/com.tailscale.webos'
    add_dir(app_base)
    for root, dirs, files in os.walk(os.path.join(build_dir, 'app')):
        rel = os.path.relpath(root, os.path.join(build_dir, 'app'))
        clean_rel = rel.replace('\\', '/')
        target_dir = app_base if rel == '.' else f'{app_base}/{clean_rel}'
        if rel != '.':
            add_dir(target_dir)
        for f in sorted(files):
            full = os.path.join(root, f)
            tpath = f'{target_dir}/{f}'
            ti = tarfile.TarInfo(tpath)
            ti.size = os.path.getsize(full)
            ti.mtime = int(time.time())
            ti.mode = 0o777
            ti.uid = 1001
            ti.gid = 1001
            ti.uname = 'developer'
            ti.gname = 'developer'
            with open(full, 'rb') as fh:
                tar.addfile(ti, fh)

    # Add pkg
    pkg_base = 'usr/palm/packages/com.tailscale.webos'
    add_dir(pkg_base)
    pinfo = os.path.join(build_dir, 'pkg', 'packageinfo.json')
    ti = tarfile.TarInfo(f'{pkg_base}/packageinfo.json')
    ti.size = os.path.getsize(pinfo)
    ti.mode = 0o644
    ti.uid = 1001
    ti.gid = 1001
    ti.uname = 'developer'
    ti.gname = 'developer'
    with open(pinfo, 'rb') as fh:
        tar.addfile(ti, fh)

    # Add service
    svc_base = 'usr/palm/services/com.tailscale.webos.service'
    add_dir(svc_base)
    for root, dirs, files in os.walk(os.path.join(build_dir, 'service')):
        rel = os.path.relpath(root, os.path.join(build_dir, 'service'))
        clean_rel = rel.replace('\\', '/')
        target_dir = svc_base if rel == '.' else f'{svc_base}/{clean_rel}'
        if rel != '.':
            add_dir(target_dir)
        for f in sorted(files):
            full = os.path.join(root, f)
            tpath = f'{target_dir}/{f}'
            ti = tarfile.TarInfo(tpath)
            ti.size = os.path.getsize(full)
            ti.mtime = int(time.time())
            ti.mode = 0o777
            ti.uid = 1001
            ti.gid = 1001
            ti.uname = 'developer'
            ti.gname = 'developer'
            with open(full, 'rb') as fh:
                tar.addfile(ti, fh)

data_data = data_bio.getvalue()

# 4. Assemble GNU ar archive
def ar_header(name, size):
    hdr = f'{name:<16}'
    hdr += f'{int(time.time()):<12}'
    hdr += '0     0     100644  '
    hdr += f'{size:<10}'
    hdr += '\x60\n'
    return hdr.encode('ascii')

with open(out_ipk, 'wb') as f:
    f.write(b'!<arch>\n')
    
    # debian-binary
    f.write(ar_header('debian-binary/', len(deb_binary)))
    f.write(deb_binary)
    if len(deb_binary) % 2 == 1: f.write(b'\n')
    
    # control.tar.gz
    f.write(ar_header('control.tar.gz/', len(control_data)))
    f.write(control_data)
    if len(control_data) % 2 == 1: f.write(b'\n')
    
    # data.tar.gz
    f.write(ar_header('data.tar.gz/', len(data_data)))
    f.write(data_data)
    if len(data_data) % 2 == 1: f.write(b'\n')

print(f'IPK successfully created at {out_ipk}! Size: {os.path.getsize(out_ipk)} bytes')

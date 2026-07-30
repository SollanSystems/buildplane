#!/usr/bin/env python3
"""Socket-activation launcher: bind+listen as root, hand fd 3 to a non-root host.

This reproduces what the shipped systemd socket unit does (SocketUser=root,
SocketMode=0660, DirectoryMode=0755, User=<broker>) without requiring systemd
inside the container. The host itself NEVER binds: it validates an inherited
listener on fd 3 and refuses anything else.

It reads no environment overrides and passes no argv to the host: both bin/main()
guards reject `args_os().len() != 1`.

usage: launch-host.py --stderr <path> --facts <path>
"""
import json
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import params as P  # noqa: E402

SO_DOMAIN = getattr(socket, "SO_DOMAIN", 39)
SO_ACCEPTCONN = getattr(socket, "SO_ACCEPTCONN", 30)


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def main():
    stderr_path = arg("--stderr", os.path.join(P.OUT_DIR, "host.stderr"))
    facts_path = arg("--facts", os.path.join(P.OUT_DIR, "listener-facts.json"))

    assert os.geteuid() == 0, "the listener must be created by an EUID-0 process"

    # provision.py built this chain; assert it rather than trusting it, because a
    # wrong mode here surfaces only as the opaque startup_failed.
    for path in ("/run", "/run/buildplane", P.RUN_DIR):
        st = os.lstat(path)
        assert st.st_uid == 0 and (st.st_mode & 0o7777) == 0o755, \
            f"{path} must be root-owned mode 0755"

    if os.path.lexists(P.SOCKET_PATH):
        os.remove(P.SOCKET_PATH)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(P.SOCKET_PATH)
    # listen(2) is what stamps SO_PEERCRED on the listening endpoint. It MUST
    # happen while this process is still EUID 0: the client config pins
    # listener_creator_uid to 0 and re-verifies it four times per exchange. The
    # kernel takes that credential as a SNAPSHOT in unix_listen(), so a later
    # setuid()+execve() in this same PID does not rewrite it.
    euid_at_listen = os.geteuid()
    sock.listen(128)
    # bind(2) creates the node with the caller's euid/egid and a umask-derived
    # mode; neither is what the host requires. Set both explicitly.
    os.chown(P.SOCKET_PATH, 0, P.SOCKET_GID)
    os.chmod(P.SOCKET_PATH, 0o660)

    listener_facts = {
        "euid_at_listen": euid_at_listen,
        "is_socket": os.fstat(sock.fileno()).st_mode & 0o170000 == 0o140000,
        "so_domain": sock.getsockopt(socket.SOL_SOCKET, SO_DOMAIN),
        "so_type": sock.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE),
        "so_acceptconn": sock.getsockopt(socket.SOL_SOCKET, SO_ACCEPTCONN),
        "getsockname": sock.getsockname(),
    }

    raw = sock.fileno()
    if raw == P.LISTENER_FD:
        spare = os.dup(raw)      # lands >= 4
        sock.close()             # releases fd 3
        os.dup2(spare, P.LISTENER_FD)
        os.close(spare)
    else:
        os.dup2(raw, P.LISTENER_FD)
        sock.close()
    # REQUIRED: Python file descriptors are close-on-exec by default (PEP 446),
    # and dup2 onto an fd that is ALREADY 3 does not clear CLOEXEC. Without this
    # the kernel closes fd 3 during execve and the host fails its very first
    # check -- indistinguishable from every other startup_failed cause.
    os.set_inheritable(P.LISTENER_FD, True)
    listener_facts["fd"] = P.LISTENER_FD
    listener_facts["inheritable"] = os.get_inheritable(P.LISTENER_FD)

    os.makedirs(P.OUT_DIR, exist_ok=True)
    # Open the facts sink while still root and write through the held descriptor
    # after the privilege drop, so the recorded euid is the post-setuid value.
    facts_fd = os.open(facts_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    err = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    os.dup2(err, 2)
    if err > 2:
        os.close(err)

    os.setgroups([])
    os.setgid(P.BROKER_GID)
    os.setuid(P.BROKER_UID)
    assert os.geteuid() == P.BROKER_UID, "privilege drop did not take effect"

    listener_facts["euid_at_exec"] = os.geteuid()
    listener_facts["egid_at_exec"] = os.getegid()
    listener_facts["groups_at_exec"] = sorted(os.getgroups())
    os.write(facts_fd, json.dumps(listener_facts, sort_keys=True).encode())
    os.close(facts_fd)

    os.execv(P.HOST_BIN, ["buildplane-authority-host"])


if __name__ == "__main__":
    main()

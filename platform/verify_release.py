"""Verify a clean, relocated archive using its bundled Node, without system Node or Python inference."""
import http.cookiejar
import json
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile
from package_releases import ROOT, OUT, release_target


def verify():
    system, arch = release_target()
    archive = OUT / f'basically-os-{system}-{arch}{".zip" if system == "windows" else ".tar.gz"}'
    if not archive.exists():
        raise RuntimeError('Build the native release first.')
    with tempfile.TemporaryDirectory(prefix='basically relocated ') as temporary:
        app = Path(temporary) / 'folder with spaces'
        app.mkdir()
        if archive.suffix == '.zip':
            with zipfile.ZipFile(archive) as source:
                source.extractall(app)
        else:
            with tarfile.open(archive) as source:
                source.extractall(app, filter='data')
        assert (app / 'node_modules/@earendil-works/pi-agent-core/package.json').is_file()
        assert not (app / 'node_modules/@earendil-works/pi-coding-agent').exists()
        assert not (app / '.platform-home').exists(), 'Archive leaked a private profile'
        assert not (app / 'workspaces').exists(), 'Archive leaked workspaces'
        node = app / ('runtime/node.exe' if system == 'windows' else 'runtime/node')
        if system != 'windows':
            node.chmod(0o755)
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        env = {**os.environ, 'AGENT_PLATFORM_NO_OPEN': '1', 'BASICALLY_HOME': str(app / '.platform-home')}
        child = subprocess.Popen([str(node), str(app / 'platform/portable.mjs'), '--no-open', '--port', str(port)], cwd=app, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8')
        lines = queue.Queue()
        def drain():
            for line in child.stdout:
                lines.put(line)
        threading.Thread(target=drain, daemon=True).start()
        try:
            deadline = time.monotonic() + 40
            url = None
            while time.monotonic() < deadline:
                try:
                    line = lines.get(timeout=1)
                except queue.Empty:
                    if child.poll() is not None:
                        raise RuntimeError('Portable app exited during startup.')
                    continue
                match = re.search(r'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_-]+', line)
                if match:
                    url = match.group(0)
                    break
            if not url:
                raise RuntimeError('No authenticated launch URL.')
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            with opener.open(url, timeout=15) as response:
                html = response.read().decode()
                assert 'Space to think.' in html
            base = f'http://127.0.0.1:{port}'
            with opener.open(base + '/api/bootstrap', timeout=15) as response:
                state = json.load(response)
                assert state['providers'] == [], 'A clean install must not preload providers or models'
                assert state['defaultModel'] is None
            for path in ['/app.js', '/theme.css', '/brand-mark.svg', '/vendor/marked.js', '/vendor/purify.js']:
                with opener.open(base + path, timeout=15) as response:
                    assert response.status == 200 and len(response.read()) > 100
            print(f'Verified relocated {system}-{arch} archive: bundled Node, private storage, Pi dependencies, API state and browser assets.')
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)
            child.stdout.close()


if __name__ == '__main__':
    verify()

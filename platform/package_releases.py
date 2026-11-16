"""Native portable release: Node + npm-locked production packages + product sources only."""
from pathlib import Path
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'releases'
NODE_VERSION = '24.13.0'
PRODUCT_FILES = [
    'server.mjs', 'start.mjs', 'portable.mjs', 'browser.mjs', 'store.mjs', 'providers.mjs', 'model-catalog.mjs', 'notes.mjs', 'semantic.mjs', 'canvases.mjs', 'web-search.mjs', 'browser-research.mjs', 'folder-picker.mjs',
    'runtime.mjs', 'tools.mjs', 'icons.mjs', 'memory.mjs', 'memories.mjs', 'resources.mjs', 'resource-tools.mjs', 'resource-routes.mjs', 'ARCHITECTURE.md', 'exchange.mjs', 'model-upload.mjs', 'paths.mjs', 'local-worker.mjs', 'model_runtime.py', 'local_backends.py',
    'setup_models.py', 'requirements.txt',
]


def release_target():
    system = {'win32': 'windows', 'darwin': 'macos', 'linux': 'linux'}.get(sys.platform)
    arch = {'AMD64': 'x64', 'x86_64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
    if not system or not arch or system == 'windows' and arch != 'x64':
        raise RuntimeError('Supported targets: Windows x64, macOS x64/arm64, Linux x64/arm64.')
    return system, arch


def download(url, destination):
    print('Downloading ' + url, flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, destination.open('wb') as output:
        shutil.copyfileobj(response, output)


def write_archive(stage, output):
    pending = output.with_name(output.name + '.partial')
    def inputs():
        private = {'.platform-home', 'workspaces', 'local-models', '__pycache__', '.bin'}
        for directory, dirs, files in os.walk(stage, followlinks=False):
            dirs[:] = sorted(name for name in dirs if name not in private and not (Path(directory) / name).is_symlink() and not (Path(directory) / name).is_junction())
            for name in sorted(files):
                file = Path(directory) / name
                if file.is_file() and not file.is_symlink() and not name.startswith('.env'):
                    yield file
    if output.suffix == '.zip':
        with zipfile.ZipFile(pending, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
            for file in inputs():
                archive.write(file, file.relative_to(stage).as_posix())
    else:
        with tarfile.open(pending, 'w:gz', compresslevel=6) as archive:
            for file in inputs():
                archive.add(file, arcname=file.relative_to(stage).as_posix(), recursive=False)
    pending.replace(output)


def desktop():
    system, arch = release_target()
    subprocess.run(['node', str(ROOT / 'platform/build.mjs')], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='basically-release-') as temporary:
        temporary = Path(temporary)
        stage = temporary / 'app'
        (stage / 'platform').mkdir(parents=True)
        for name in ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'DISTRIBUTION.md']:
            shutil.copy2(ROOT / name, stage / name)
        for name in PRODUCT_FILES:
            shutil.copy2(ROOT / 'platform' / name, stage / 'platform' / name)
        shutil.copytree(ROOT / 'platform/web', stage / 'platform/web')
        shutil.copytree(ROOT / 'platform/assets', stage / 'platform/assets')
        # Fresh production install: no development/browser dependencies or machine-specific junctions.
        npm = shutil.which('npm.cmd' if os.name == 'nt' else 'npm')
        if not npm:
            raise RuntimeError('npm is required to assemble production dependencies.')
        subprocess.run([npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=stage, check=True)
        shutil.rmtree(stage / 'node_modules/.bin', ignore_errors=True)
        runtime = stage / 'runtime'
        runtime.mkdir()
        node_name = f'node-v{NODE_VERSION}-' + ('win-x64' if system == 'windows' else f'{"darwin" if system == "macos" else "linux"}-{arch}')
        extension = '.zip' if system == 'windows' else '.tar.gz'
        source = temporary / ('node' + extension)
        base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
        download(base + node_name + extension, source)
        with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=120) as response:
            checksums = response.read().decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.endswith('  ' + node_name + extension))
        with source.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise RuntimeError('Bundled Node checksum mismatch.')
        if system == 'windows':
            with zipfile.ZipFile(source) as archive:
                (runtime / 'node.exe').write_bytes(archive.read(node_name + '/node.exe'))
                (runtime / 'NODE-LICENSE.txt').write_bytes(archive.read(node_name + '/LICENSE'))
            launcher = 'Start basically OS.cmd'
            (stage / launcher).write_bytes(b'@echo off\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0platform\\portable.mjs"\r\nif errorlevel 1 pause\r\n')
            shutil.copy2(ROOT / 'setup-local-models.cmd', stage / 'Setup Local Models.cmd')
        else:
            with tarfile.open(source) as archive:
                for name, target in [('bin/node', 'node'), ('LICENSE', 'NODE-LICENSE.txt')]:
                    with archive.extractfile(node_name + '/' + name) as stream:
                        (runtime / target).write_bytes(stream.read())
            (runtime / 'node').chmod(0o755)
            launcher = 'Start basically OS.command' if system == 'macos' else 'Start basically OS.sh'
            (stage / launcher).write_text('#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec ./runtime/node platform/portable.mjs\n', encoding='utf-8')
            (stage / launcher).chmod(0o755)
            setup = 'Setup Local Models.command' if system == 'macos' else 'Setup Local Models.sh'
            shutil.copy2(ROOT / setup, stage / setup)
            (stage / setup).chmod(0o755)
        (stage / 'READ ME FIRST.txt').write_text(
            f'basically OS — {system} {arch}\n\nExtract the complete archive to a writable local folder and open {launcher}.\n'
            'Node and production npm packages are included. API use needs no Python, Git, install or build.\n'
            'OpenRouter is preselected for setup. Add your key and exact model ID, or use a custom endpoint.\n'
            'Your private data stays in .platform-home and workspaces. Never share a used profile.\n'
            'Optional local inference requires Python 3.12, an inference runtime and your own weights.\n'
            'The shell tool runs with your user permissions and always requires approval.\nSee DISTRIBUTION.md.\n', encoding='utf-8')
        output = OUT / f'basically-os-{system}-{arch}{".zip" if system == "windows" else ".tar.gz"}'
        OUT.mkdir(exist_ok=True)
        write_archive(stage, output)
        print(f'Created {output} ({output.stat().st_size:,} bytes)', flush=True)
        return output


def main():
    output = desktop()
    with output.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    (OUT / (output.name + '.sha256')).write_text(digest + '  ' + output.name + '\n', encoding='ascii')


if __name__ == '__main__':
    main()

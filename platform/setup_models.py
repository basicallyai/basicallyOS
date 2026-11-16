"""Install optional inference packages into a separate, writable app environment."""
import argparse
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description='basically OS optional model runtime setup')
    parser.add_argument('runtime', nargs='?', choices=['transformers'], default='transformers')
    parser.add_argument('--venv', type=Path, default=ROOT / '.venv', help='Writable runtime environment directory')
    args = parser.parse_args()
    environment = args.venv.expanduser().resolve()
    python = environment / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.exists():
        if os.name == 'nt':
            # Windows embedded Python intentionally lacks venv/ensurepip.
            subprocess.run(['py', '-3.12', '-m', 'venv', str(environment)], check=True)
        else:
            subprocess.run([sys.executable, '-m', 'venv', str(environment)], check=True)
    command = [str(python), '-m', 'pip', 'install',
               '-r', str(ROOT / 'platform' / 'requirements.txt')]
    subprocess.run(command, check=True)
    print('Installed the Transformers runtime. Restart basically OS. Model weights are not downloaded by setup.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Setup failed: {error}', file=sys.stderr)
        sys.exit(1)
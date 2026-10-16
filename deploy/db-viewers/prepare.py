"""Create a separate viewer login file without putting passwords in argv or Git."""
import argparse
import getpass
import os
from pathlib import Path
import re
import subprocess


def create_login(path: Path, username: str, password: str) -> None:
    """Write one new SHA-512 crypt login file; reject overwrites and unsafe input."""
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', username):
        raise ValueError('Username must contain 1-64 letters, digits, dots, underscores or hyphens.')
    if len(password) < 12 or any(character in password for character in '\r\n\x00'):
        raise ValueError('Use at least 12 password characters without line breaks or NUL.')
    result = subprocess.run(
        ['openssl', 'passwd', '-6', '-stdin'], input=password + '\n',
        text=True, capture_output=True, check=True,
    )
    encoded = result.stdout.strip()
    if not encoded.startswith('$6$'):
        raise ValueError('OpenSSL did not produce a SHA-512 crypt password hash.')
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    # The private parent protects the host file; the container's non-root Nginx reads the hash.
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
        output.write(username + ':' + encoded + '\n')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--username', default='viewer')
    parser.add_argument('--output', type=Path, required=True)
    arguments = parser.parse_args()
    password = getpass.getpass('Viewer password (at least 12 characters): ')
    if password != getpass.getpass('Confirm viewer password: '):
        parser.error('Passwords do not match.')
    create_login(arguments.output, arguments.username, password)
    print('Viewer login file created. Password was not saved in plaintext.')


if __name__ == '__main__':
    main()

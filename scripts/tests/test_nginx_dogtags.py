"""Validate server nginx and real upload limits in disposable isolated containers."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
NGINX_IMAGE = os.environ.get('NGINX_TEST_IMAGE', 'nginx:1.28-alpine')
PROBE_IMAGE = os.environ.get('REPORTING_TEST_BACKEND_IMAGE', 'reporting/backend:offline')

PROBE = r'''
import socket, ssl, sys, time
port, host, expected = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
for path, wanted in [('/api/dogtags-manager/intakes', expected), ('/api/health', 413), ('/voice-api/api/health', 413 if host.startswith('api.') else 100)]:
    for attempt in range(50):
        try:
            connection = socket.create_connection(('127.0.0.1', port), timeout=3)
            break
        except OSError:
            time.sleep(0.05)
    else:
        raise AssertionError('nginx did not start')
    if port == 443:
        connection = ssl._create_unverified_context().wrap_socket(connection, server_hostname=host)
    with connection:
        request = (f'POST {path} HTTP/1.1\r\nHost: {host}\r\n'
                   'Content-Length: 53477376\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n')
        connection.sendall(request.encode())
        status = int(connection.recv(4096).split(b'\r\n', 1)[0].split()[1])
        assert status == wanted, (host, path, status, wanted)
'''


class NginxDogtagsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.directory = Path(cls.temp.name)
        shutil.copytree(ROOT / 'deploy/nginx/snippets', cls.directory / 'snippets')
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                        '-keyout', str(cls.directory / 'key.pem'), '-out', str(cls.directory / 'cert.pem'),
                        '-days', '1', '-subj', '/CN=nginx-config-test.invalid'],
                       check=True, capture_output=True)
        (cls.directory / 'snippets/ssl-reporting.conf').write_text(
            'ssl_certificate /suite/cert.pem;\nssl_certificate_key /suite/key.pem;\n')

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def check_site(self, filename, host, tls, api_host=True):
        (self.directory / 'site.conf').write_text(
            (ROOT / 'deploy/nginx' / filename).read_text().replace('__DOMAIN__', 'example.test'))
        (self.directory / 'nginx.conf').write_text(
            'error_log /dev/stderr; pid /tmp/nginx.pid; events {}\n'
            'http { include /suite/site.conf; server { listen 8000; '
            'client_max_body_size 260m; location / { return 204; } } }\n')
        base = ['docker', 'run', '--rm', '--network', 'none',
                '-v', f'{self.directory}:/suite:ro', '--entrypoint', 'nginx', NGINX_IMAGE,
                '-p', '/suite/', '-c', '/suite/nginx.conf']
        syntax = subprocess.run(base + ['-t'], capture_output=True, text=True)
        self.assertEqual(syntax.returncode, 0, syntax.stderr)
        started = subprocess.run(base[:2] + ['-d'] + base[2:] + ['-g', 'daemon off;'],
                                 capture_output=True, text=True, check=True)
        container = started.stdout.strip()
        try:
            for name in ([host, 'api.' + host] if api_host else [host]):
                result = subprocess.run(
                    ['docker', 'run', '--rm', '--network', 'container:' + container,
                     PROBE_IMAGE, 'python', '-c', PROBE, '443' if tls else '80', name, '100'],
                    capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            subprocess.run(['docker', 'rm', '-f', container], capture_output=True, check=True)

    def test_https_sites_accept_dogtags_files_without_changing_other_api_limits(self):
        for filename, host in [('reporting.conf', 'taskatestovaya.ru'), ('t2product.conf', 't2product.ru')]:
            with self.subTest(site=filename):
                self.check_site(filename, host, True)

    def test_http_sites_accept_dogtags_files_without_changing_other_api_limits(self):
        for filename, host, api_host in [('t2product-http.conf', 't2product.ru', True),
                                         ('reporting.certbot-bootstrap.conf', 'taskatestovaya.ru', True),
                                         ('dev-http.conf.template', 'example.test', True),
                                         ('dev-any-host.conf', 'example.test', False)]:
            with self.subTest(site=filename):
                self.check_site(filename, host, False, api_host)


if __name__ == '__main__':
    unittest.main()

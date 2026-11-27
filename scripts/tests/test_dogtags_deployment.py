"""Check the real Compose graph without starting or changing containers."""
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DogtagsDeploymentTests(unittest.TestCase):
    def config(self, mode, enabled, local_override=False, switch=None, legacy=False, public_url="https://t2product.ru"):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / 'test.env'
            settings = [
                'COMPOSE_PROJECT_NAME=reporting-module-test',
            ]
            if public_url is not None:
                settings += ['APP_PUBLIC_URL=' + public_url]
            if enabled is not None:
                settings += [f'REPORTING_DOGTAGS_ENABLED={int(enabled) if switch is None else switch} # module switch']
            if enabled:
                settings += ['REPORTING_DOGTAGS_POSTGRES_PASSWORD=synthetic-dogtags-db',
                             'REPORTING_DOGTAGS_RABBITMQ_PASSWORD=synthetic-dogtags-queue']
            if local_override:
                override = Path(tmp) / 'settings # override.yml'
                override.write_text('services:\n  backend:\n    environment:\n      LOCAL_OVERRIDE_TEST: preserved\n')
                settings += [f'COMPOSE_LOCAL_OVERRIDE="{override}" # local settings']
            env_file.write_text('\n'.join(settings) + '\n')
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(('COMPOSE_', 'REPORTING_DOGTAGS_', 'DOGTAGS_MANAGER_'))}
            env['COMPOSE_ENV_FILE'] = str(env_file)
            if legacy:
                wrapper = Path(tmp) / 'compose-legacy'
                wrapper.write_text('#!/usr/bin/env bash\nfor arg in "$@"; do\n'
                                   '  [[ "$arg" == "--environment" ]] && exit 2\ndone\n'
                                   'exec docker compose "$@"\n')
                wrapper.chmod(0o700)
                env['COMPOSE_CMD'] = str(wrapper)
            result = subprocess.run(
                ['bash', '-ec', 'source scripts/resolve-compose.sh "$1"; "${COMPOSE[@]}" config --format json',
                 'compose-test', mode], cwd=ROOT, env=env, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)

    def test_new_install_requires_no_dogtags_settings(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                services = self.config('prod', None, legacy=legacy)['services']
                self.assertEqual(services['backend']['environment']['DOGTAGS_MANAGER_ORIGIN'], 'https://t2product.ru')
                self.assertEqual(services['dogtags-api']['environment']['APP_ORIGIN'], 'https://t2product.ru')
                self.assertEqual(services['dogtags-secrets']['network_mode'], 'none')
                for name in ('dogtags-api', 'dogtags-worker', 'dogtags-dispatcher', 'dogtags-init'):
                    environment = services[name]['environment']
                    self.assertNotIn('POSTGRES_PASSWORD', environment)
                    self.assertNotIn('RABBITMQ_PASSWORD', environment)
                    self.assertEqual(environment['POSTGRES_PASSWORD_FILE'], '/run/dogtags-postgres/password')
                    secret_mounts = [v for v in services[name]['volumes'] if v['target'].startswith('/run/dogtags-')]
                    self.assertEqual(len(secret_mounts), 2)
                    self.assertTrue(all(v['read_only'] for v in secret_mounts))
                self.assertEqual(services['dogtags-postgres']['environment']['POSTGRES_PASSWORD_FILE'],
                                 '/run/dogtags-postgres/password')
                self.assertNotIn('RABBITMQ_DEFAULT_PASS', services['dogtags-rabbitmq']['environment'])

    def test_origin_inherits_reporting_default_when_public_url_is_not_overridden(self):
        services = self.config('prod', None, public_url=None)['services']
        self.assertEqual(services['dogtags-api']['environment']['APP_ORIGIN'],
                         services['backend']['environment']['APP_PUBLIC_URL'])

    def test_http_reporting_keeps_private_dogtags_origin_valid(self):
        services = self.config('offline', None, public_url='http://t2product.ru')['services']
        self.assertEqual(services['backend']['environment']['APP_PUBLIC_URL'], 'http://t2product.ru')
        self.assertEqual(services['backend']['environment']['DOGTAGS_MANAGER_ORIGIN'], 'http://127.0.0.1:8000')
        self.assertEqual(services['dogtags-api']['environment']['APP_ORIGIN'], 'http://127.0.0.1:8000')

    def test_disabled_module_does_not_require_dogtags_secrets(self):
        config = self.config('prod', False)
        self.assertIn('voice-web', config['services'])
        self.assertNotIn('dogtags-api', config['services'])

    def test_enabled_module_is_isolated_in_same_project(self):
        for mode in ('prod', 'offline', 'corp-direct'):
            with self.subTest(mode=mode):
                baseline = self.config(mode, False)
                config = self.config(mode, True)
                services = config['services']
                for name in ('dogtags-secrets', 'dogtags-postgres', 'dogtags-rabbitmq', 'dogtags-init',
                             'dogtags-api', 'dogtags-worker', 'dogtags-dispatcher'):
                    self.assertTrue(name in services, name)
                    self.assertFalse(services[name].get('ports'), name)
                for name, original in baseline['services'].items():
                    original, candidate = deepcopy(original), deepcopy(services[name])
                    if name == 'backend':
                        for value in (original, candidate):
                            for key in ('DOGTAGS_MANAGER_URL', 'DOGTAGS_MANAGER_ORIGIN'):
                                value['environment'].pop(key, None)
                        candidate['networks'].pop('dogtags-gateway', None)
                    self.assertTrue(candidate == original, f'{mode}: {name} configuration changed')
                legacy_storage = {mount['source'] for service in baseline['services'].values()
                                  for mount in service.get('volumes', [])}
                for name, service in services.items():
                    if name.startswith('dogtags-'):
                        storage = {mount['source'] for mount in service.get('volumes', [])}
                        self.assertTrue(storage.isdisjoint(legacy_storage), f'{mode}: {name} shares storage')
                self.assertEqual(services['backend']['environment']['DOGTAGS_MANAGER_URL'], 'http://dogtags-api:8000')
                self.assertEqual(services['dogtags-api']['environment']['APP_ORIGIN'], 'https://t2product.ru')
                self.assertNotIn('default', services['dogtags-api']['networks'])
                self.assertTrue(config['networks']['dogtags-private']['internal'])
                self.assertFalse(config['networks']['dogtags-gateway'].get('external', False))
                self.assertEqual(set(services['dogtags-postgres']['networks']), {'dogtags-private'})
                self.assertNotEqual(services['dogtags-postgres']['volumes'][0]['source'],
                                    services['postgres']['volumes'][0]['source'])
                self.assertEqual(config['name'], 'reporting-module-test')
    def test_offline_mode_uses_bundled_dogtags_database_and_queue(self):
        services = self.config('offline', True)['services']
        self.assertEqual(services['dogtags-postgres']['image'], 'reporting/dogtags-postgres:17')
        self.assertEqual(services['dogtags-rabbitmq']['image'], 'reporting/dogtags-rabbitmq:4.2')
        self.assertEqual(services['dogtags-api']['image'], 'reporting/dogtags-manager:reporting-v2')

    def test_legacy_opt_out_with_dotenv_comment_keeps_reporting_available(self):
        for override in (False, True):
            with self.subTest(override=override):
                baseline = self.config('prod', False, local_override=override)
                legacy = self.config('prod', False, local_override=override, legacy=True)
                self.assertTrue(legacy['services'] == baseline['services'])

    def test_invalid_module_switch_is_rejected_clearly(self):
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.config('prod', True, switch='enabled')
        self.assertIn('REPORTING_DOGTAGS_ENABLED', failure.exception.stderr)

    def test_local_override_is_applied_with_selected_env_file(self):
        services = self.config('dev', True, local_override=True)['services']
        self.assertEqual(services['backend']['environment']['LOCAL_OVERRIDE_TEST'], 'preserved')
        self.assertEqual(services['dogtags-secrets']['environment']['REPORTING_DOGTAGS_POSTGRES_PASSWORD'], 'synthetic-dogtags-db')


if __name__ == '__main__':
    unittest.main()

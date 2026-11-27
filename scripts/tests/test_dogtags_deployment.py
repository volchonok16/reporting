"""Check the real Compose graph without starting or changing containers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DogtagsDeploymentTests(unittest.TestCase):
    def config(self, mode, enabled, local_override=False, switch=None):
        with tempfile.TemporaryDirectory() as tmp:
            env_file = Path(tmp) / 'test.env'
            settings = [
                'COMPOSE_PROJECT_NAME=reporting-module-test',
                f'REPORTING_DOGTAGS_ENABLED={int(enabled) if switch is None else switch} # module switch',
                'DOGTAGS_MANAGER_ORIGIN=https://t2product.ru',
            ]
            if enabled:
                settings += ['REPORTING_DOGTAGS_POSTGRES_PASSWORD=synthetic-dogtags-db',
                             'REPORTING_DOGTAGS_RABBITMQ_PASSWORD=synthetic-dogtags-queue']
            if local_override:
                override = Path(tmp) / 'local.yml'
                override.write_text('services:\n  backend:\n    environment:\n      LOCAL_OVERRIDE_TEST: preserved\n')
                settings += [f'COMPOSE_LOCAL_OVERRIDE="{override}" # local settings']
            env_file.write_text('\n'.join(settings) + '\n')
            env = {key: value for key, value in os.environ.items()
                   if not key.startswith(('COMPOSE_', 'REPORTING_DOGTAGS_', 'DOGTAGS_MANAGER_'))}
            env['COMPOSE_ENV_FILE'] = str(env_file)
            result = subprocess.run(
                ['bash', '-ec', 'source scripts/resolve-compose.sh "$1"; "${COMPOSE[@]}" config --format json',
                 'compose-test', mode], cwd=ROOT, env=env, capture_output=True, text=True, check=True)
            return json.loads(result.stdout)

    def test_disabled_module_does_not_require_dogtags_secrets(self):
        config = self.config('prod', False)
        self.assertIn('voice-web', config['services'])
        self.assertNotIn('dogtags-api', config['services'])

    def test_enabled_module_is_isolated_in_same_project(self):
        baseline = self.config('prod', False)
        config = self.config('prod', True)
        services = config['services']
        for name in ('dogtags-postgres', 'dogtags-rabbitmq', 'dogtags-init',
                     'dogtags-api', 'dogtags-worker', 'dogtags-dispatcher'):
            self.assertTrue(name in services, name)
            self.assertFalse(services[name].get('ports'), name)
        self.assertEqual(services['voice-web'], baseline['services']['voice-web'])
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
        self.assertEqual(services['dogtags-api']['image'], 'reporting/dogtags-manager:534b82f')

    def test_invalid_module_switch_is_rejected_clearly(self):
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.config('prod', True, switch='enabled')
        self.assertIn('REPORTING_DOGTAGS_ENABLED', failure.exception.stderr)

    def test_local_override_is_applied_with_selected_env_file(self):
        services = self.config('dev', True, local_override=True)['services']
        self.assertEqual(services['backend']['environment']['LOCAL_OVERRIDE_TEST'], 'preserved')
        self.assertEqual(services['dogtags-postgres']['environment']['POSTGRES_PASSWORD'], 'synthetic-dogtags-db')


if __name__ == '__main__':
    unittest.main()

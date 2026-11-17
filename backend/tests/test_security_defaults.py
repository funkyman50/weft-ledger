import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.config import get_settings, validate_installation_secret


class SecurityDefaultsTests(unittest.TestCase):
    def test_startup_refuses_unsafe_installation_keys(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'saved.db'
            environment = {'WEFT_DB_PATH': str(database), 'WEFT_SECRET': 'ab' * 32}
            for name, value in [('WEFT_SECRET', ''), ('WEFT_SECRET', 'weak-installation-key')]:
                with self.subTest(name=name, value=value), patch.dict(os.environ, {**environment, name: value}):
                    with self.assertRaises(ValueError):
                        get_settings()
            with self.assertRaises(ValueError):
                validate_installation_secret('weak-restore-key')
            with patch.dict(os.environ, environment):
                self.assertEqual(get_settings().db_path, str(database))

    def test_actual_app_admits_its_page_and_rejects_hostile_browser_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run([sys.executable, '-c', '''
from fastapi.testclient import TestClient
from app.main import app
store = app.state.password_store
store.change(store.load().revision, '', 'synthetic-login-password')
with TestClient(app, base_url='http://localhost:9099') as client:
    response = client.post('/login', headers={'Host': 'attacker.invalid', 'Origin': 'http://attacker.invalid'}, json={'password': 'synthetic-login-password'})
    assert response.status_code == 400 and not response.cookies
    response = client.post('/login', json={'password': 'synthetic-login-password'})
    assert response.status_code == 403 and not response.cookies
    response = client.post('/login', headers={'Origin': 'https://attacker.invalid'}, json={'password': 'synthetic-login-password'})
    assert response.status_code == 403 and not response.cookies
    response = client.post('/login', headers={'Origin': 'http://localhost:9099'}, json={'password': 'synthetic-login-password'})
    assert response.status_code == 200 and 'weft_session' in response.cookies
    assert client.get('/api/accounts').status_code == 200
    assert client.get('/api/accounts', headers={'Sec-Fetch-Site': 'cross-site'}).status_code == 403
    response = client.get('/auth/callback?state=invalid', headers={'Host': '127.0.0.1:8000', 'Sec-Fetch-Site': 'cross-site'})
    assert response.status_code == 409 and 'ChatGPT connection incomplete' in response.text
'''], env={**os.environ, 'WEFT_DB_PATH': str(Path(folder) / 'disposable.db'), 'WEFT_SECRET': 'ab' * 32}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()

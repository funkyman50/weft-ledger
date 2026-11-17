import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx

from app.config import Settings
from app.errors import AppError
from app.services.openai_connection import Installation, OpenAIConnection, Registration, Tokens


class OpenAIConnectionCheckTests(unittest.TestCase):
    def test_streamed_json_requires_successful_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings("synthetic-password", "synthetic-secret", str(Path(directory) / "register.db"))
            owner = OpenAIConnection(settings)
            owner.installation = Installation(
                ai_disabled=False, selected_model="synthetic-model", active_client_id="oaiapp_synthetic",
                registrations=[Registration(
                    client_id="oaiapp_synthetic", subject="synthetic-subject", usage_acknowledged=True,
                    tokens=Tokens(access_token="synthetic-access", refresh_token=None, id_token="synthetic-id", expires_at=time.time() + 3600, scopes=["chatgpt.tokens.use.direct"]),
                )],
            )
            events = []

            def provider(request):
                if request.url.path == "/v1/models":
                    return httpx.Response(200, json={"models": [{"slug": "synthetic-model", "display_name": "Synthetic model", "visibility": "list"}]})
                self.assertEqual(request.url.path, "/v1/responses")
                return httpx.Response(200, text="".join("data: " + json.dumps(event) + "\n\n" for event in events))

            owner.http.close()
            owner.http = httpx.Client(transport=httpx.MockTransport(provider))
            terminal = {"type": "response.completed", "response": {"status": "completed", "output": []}}
            final_text = {"type": "response.output_text.done", "text": '{"payee":"Example Market"}'}
            try:
                events[:] = [final_text, terminal]
                result = owner.check_connection(owner.status()["revision"])
                self.assertEqual(result["model"], "synthetic-model")

                events[:] = [final_text]
                with self.assertRaises(AppError):
                    owner.check_connection(owner.status()["revision"])
            finally:
                owner.close()


if __name__ == "__main__":
    unittest.main()

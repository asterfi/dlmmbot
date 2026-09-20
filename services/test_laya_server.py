import unittest

from laya_server import _loopback_host, validate_request


class RequestValidationTests(unittest.TestCase):
    def test_host_override_remains_loopback_only(self):
        self.assertEqual(_loopback_host("127.0.0.1"), "127.0.0.1")
        self.assertEqual(_loopback_host("::1"), "::1")
        self.assertIsNone(_loopback_host("0.0.0.0"))

    def test_accepts_normalized_snapshot(self):
        request, error = validate_request({
            "state": {"strategy": "eys", "candidate": {"mint": "mint"}},
            "questions": {
                "trade": {
                    "type": "noul",
                    "instructions": "Is this qualified?",
                    "criteria": {"true": "Yes", "false": "No"},
                },
                "stage": {
                    "type": "choice",
                    "instructions": "Which stage?",
                    "criteria": {"reject": "No", "anchor": "Yes"},
                },
            },
        })
        self.assertIsNone(error)
        self.assertIsNotNone(request)

    def test_rejects_missing_questions(self):
        request, error = validate_request({"state": {"strategy": "eys"}})
        self.assertIsNone(request)
        self.assertIn("questions", error or "")

    def test_rejects_unknown_question_type(self):
        request, error = validate_request({
            "state": {},
            "questions": {"trade": {"type": "freeform", "instructions": "x"}},
        })
        self.assertIsNone(request)
        self.assertIn("unsupported", error or "")

    def test_rejects_unbounded_question_envelope(self):
        request, error = validate_request({
            "state": {},
            "questions": {
                "trade": {
                    "type": "noul",
                    "instructions": "x",
                },
            },
        })
        self.assertIsNone(request)
        self.assertIn("criteria", error or "")


if __name__ == "__main__":
    unittest.main()

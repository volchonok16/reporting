"""Contract expectations come from the supplied Callmark v4 package (§4–6)."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class ContractDefinitionsTest(unittest.TestCase):
    def test_hub_columns_and_profile_are_exact(self):
        contract = json.loads((ROOT / "contracts/hub-v1.json").read_text())
        self.assertEqual(contract["columns"], ["INN", "MSISDN", "MAV_LABEL_NAME", "MAV_LABEL_LATIN", "IS_MAV", "IS_KSS"])
        self.assertEqual(contract["profile"], {"id": "hub-v1", "name": "RTK HUB", "SPREADING": "0", "INTERNAL_OPERATOR_NAME": "hubRTK"})
        self.assertEqual(contract["identifier_type"], "string")

    def test_output_columns_and_required_values_are_exact(self):
        contract = json.loads((ROOT / "contracts/output-v1.json").read_text())
        expected = {
            "CLIENTS": ["COMPANY_NAME", "COMPANY_CONTRACT", "MAV_OPERATOR_NAME", "INN"],
            "DOGTAGS": ["INN", "MAV_LABEL", "MAV_LABEL_LATIN", "IS_ACTIVE"],
            "NUMBERS": ["INN", "MAV_LABEL_NAME", "MSISDN", "IS_MAV", "IS_KSS", "SPREADING", "INTERNAL_OPERATOR_NAME"],
        }
        self.assertEqual(contract["order"], list(expected))
        for name, columns in expected.items():
            self.assertEqual(contract["files"][name]["columns"], columns)
            self.assertNotIn("STATUS", columns)
        self.assertEqual(contract["files"]["CLIENTS"]["required"], ["INN"])
        self.assertEqual(contract["files"]["DOGTAGS"]["constants"], {"IS_ACTIVE": "1"})
        self.assertEqual(contract["serialization"], {"version": "cp1251-crlf-v1", "encoding": "cp1251", "bom": False, "delimiter": ";", "line_ending": "\r\n", "errors": "strict"})


if __name__ == "__main__":
    unittest.main()

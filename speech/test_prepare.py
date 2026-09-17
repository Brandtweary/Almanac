import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from prepare import verify


class AssetTests(unittest.TestCase):
    def test_verified_bytes_and_same_length_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'fixture').write_bytes(b'abc')
            rows=[{'file':'fixture','bytes':3,'sha256':hashlib.sha256(b'abc').hexdigest()}]
            with patch('prepare.json.loads',return_value=rows):
                verify(root)
                (root/'fixture').write_bytes(b'abd')
                with self.assertRaisesRegex(ValueError,'verification failed'):verify(root)

    def test_missing_and_escaping_paths_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            with patch('prepare.json.loads',return_value=[{'file':'missing'}]):
                with self.assertRaises(FileNotFoundError):verify(root)
            with patch('prepare.json.loads',return_value=[{'file':'../outside'}]):
                with self.assertRaises(ValueError):verify(root)


if __name__=='__main__':unittest.main()

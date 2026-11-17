import tempfile
import unittest
from pathlib import Path

from app.db import init_db, make_session_factory
from app.errors import AppError
from app.models import Category
from app.schemas import CategoryCreate
from app.services.categories import create_category


class CategoryNameTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        database_path = Path(self.temporary_directory.name) / "categories.db"
        self.engine, self.session_local = make_session_factory(str(database_path))
        init_db(self.engine)
        self.db = self.session_local()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()
        self.temporary_directory.cleanup()

    def test_unicode_casefolded_name_is_rejected_in_the_same_scope(self):
        result = create_category(self.db, CategoryCreate(name=" Éducation "))

        category = self.db.get(Category, result["id"])
        self.assertEqual(category.name_key, "éducation")
        with self.assertRaises(AppError) as raised:
            create_category(self.db, CategoryCreate(name="éducation"))
        self.assertEqual(raised.exception.code, "duplicate_category_name")


if __name__ == "__main__":
    unittest.main()

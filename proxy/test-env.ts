// Shared process configuration must precede every test import of the cached app.
process.env.DB_PATH = ":memory:";
process.env.OWNER_OPENROUTER_KEY = "sk-test-owner";
process.env.TRUSTED_PROXY = "*";
process.env.OPENROUTER_PROVISIONING_KEY = "sk-test-prov";

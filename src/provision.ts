import { configuredStore } from './config.js';

const name = process.argv[2];
if (!name) {
  console.error('Usage: npm run provision -- "Tenant name"');
  process.exit(2);
}
const store = configuredStore();
try {
  const tenant = store.provision(name);
  console.log(
    JSON.stringify({ tenantId: tenant.id, name: tenant.name, apiToken: tenant.apiToken }, null, 2),
  );
  console.error(
    'Save this new token securely. Only its hash is stored; it cannot be retrieved later.',
  );
} finally {
  store.close();
}

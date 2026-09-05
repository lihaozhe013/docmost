use this .env to quickly start:

```bash
# your domain, e.g https://example.com
APP_URL=http://localhost:3000
PORT=3000

# minimum of 32 characters. Generate one with: openssl rand -hex 32
APP_SECRET=102030405060708090102030405060708090

JWT_TOKEN_EXPIRES_IN=30d

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/docmost?schema=public"
REDIS_URL=redis://127.0.0.1:6379

# options: local | s3 | azure
STORAGE_DRIVER=local
```

run this to create a db:

```bash
pnpm nx run server:migration:latest
```

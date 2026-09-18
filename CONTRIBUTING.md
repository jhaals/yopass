# How to contribute to Yopass

First of all, thank you for taking the time to contribute to Yopass! 🎉

## Getting Started

### Prerequisites

**Backend Development (Go):**
- Go matching the version in `go.mod`
- Redis or Memcached for storage
- Git

**Frontend Development (React/TypeScript):**
- Node.js 24 (the version used by CI)
- Yarn package manager
- Modern browser for testing

### Local Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/jhaals/yopass.git
   cd yopass
   ```

2. **Backend setup:**
   ```bash
   # Start Redis (for development)
   docker run -d -p 6379:6379 redis:alpine

   # Run the server
   go run ./cmd/yopass-server --database=redis --redis=redis://localhost:6379/0
   ```

3. **Frontend setup:**
   ```bash
   cd website/
   yarn install --frozen-lockfile
   yarn dev  # Starts development server on http://localhost:3000
   ```

## Development Workflow

### Code Quality & Linting

We maintain high code quality standards with automated linting and formatting:

**Frontend (TypeScript/React):**
```bash
cd website/

# Lint and check formatting
yarn lint

# Auto-fix linting issues and format code
yarn format

# Type checking
yarn build  # Includes TypeScript compilation
```

**Backend (Go):**
```bash
# Format code
go fmt ./...

# Vet code
go vet ./...
```

### Code Style Guidelines

**Frontend:**
- Use function declarations instead of arrow functions (`function foo() {}` not `const foo = () => {}`)
- TypeScript strict mode enabled
- Prettier for code formatting
- ESLint for code quality
- No React.FC usage - prefer function declarations

**Backend:**
- Standard Go formatting with `gofmt`
- Follow Go best practices and idioms
- Use meaningful variable and function names
- Include comprehensive error handling

### Testing

Testing is mandatory for all contributions. We use a hybrid testing approach:

**Frontend Testing:**
```bash
cd website/

# Install browser binaries once
yarn playwright install

# Unit tests and browser tests
yarn test

# Run either suite separately
yarn test:unit
yarn test:e2e

# Unit coverage across all application source, including untested files
yarn test:coverage

```

Website coverage reports are written to `website/coverage/` (open `index.html`).
They measure Vitest unit tests only; Playwright browser coverage is not included.
Use the per-file report to identify missing behavior tests rather than treating
the overall percentage as a measure of browser-test coverage.

**Backend Testing:**
```bash
# Run all tests
go test ./...

# Include database integration tests and race detection
REDIS_URL=redis://localhost:6379/0 MEMCACHED=localhost:11211 go test -race ./...

# The Lambda adapter is a separate Go module
(cd deploy/cdk && go test ./...)

# Run specific package tests
go test ./pkg/server/...
```

Redis and Memcached tests skip when their environment variables are absent.
The Lambda module's DynamoDB integration tests require `DYNAMODB_ENDPOINT` pointing
to DynamoDB Local; its unit tests run without it.

**Test Requirements:**
- **Unit tests** for all utility functions and business logic
- **Integration tests** for API endpoints
- **End-to-end tests** for complete user workflows
- **100% coverage** required for security-critical functions (crypto, random generation)
- **95%+ coverage** target for API layers

## I found a bug

Please submit an issue with a detailed description and as much relevant information as possible:

**For Backend Issues:**
- Go version
- Operating system
- Database backend (Redis/Memcached version)
- Server configuration
- Log output (if available)

**For Frontend Issues:**
- Browser name and version
- Operating system
- Console errors (F12 Developer Tools)
- Steps to reproduce
- Expected vs actual behavior

**Security Issues:**
Please report security vulnerabilities privately by emailing the maintainers rather than opening a public issue.

## Pull Requests and Features

### Before Submitting

1. **Discuss larger changes** in an issue before implementing
2. **Smaller tweaks** and bug fixes don't need prior discussion
3. **Check existing issues** to avoid duplicate work
4. **Follow the code style** outlined above

### PR Requirements

- [ ] **Tests included** - All changes must have appropriate tests
- [ ] **Linting passes** - `yarn lint` (frontend) and `go vet ./...` (backend)
- [ ] **Tests pass** - Both unit and integration tests
- [ ] **Documentation updated** - Update relevant docs if needed
- [ ] **Security reviewed** - Consider security implications of changes

### PR Description Template

```markdown
## Description
Brief description of changes and why they're needed.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests added/updated
- [ ] E2E tests added/updated
- [ ] Manual testing completed

## Security Considerations
Describe any security implications and how they've been addressed.

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Tests pass locally
- [ ] Documentation updated
```

### Commit Message Guidelines

Use clear, descriptive commit messages:

```bash
# Good examples
Add streaming upload support for large files
Fix one-time secret enforcement in upload flow
Update README with new deployment options

# Avoid
Fix bug
Update code
WIP
```

## Development Guidelines

### Frontend Architecture

The application lives in `website/src`:

- `app/`: routes and the application shell.
- `features/`: creation, retrieval, requests, and receipts.
- `shared/components/`: reusable UI components.
- `shared/context/`: providers and their context objects.
- `shared/hooks/`: React hooks that consume context or manage component state.
- `shared/lib/`: API access, configuration parsing, crypto, and local persistence.
- `shared/locales/`: translations; `yarn check:locales` checks their keys.

Unit tests sit beside the code they test. Browser tests live in `website/tests`.
Configuration validation belongs in `shared/lib/config.ts`; the provider owns
loading it. API helpers return `{ data, status, message }`: callers must check
`data` before treating a response as successful, including HTTP 200 responses.
Local request persistence errors propagate because losing a private key would
make a request unrecoverable.

### Browser storage security

Secret-request history persists private keys and management tokens unencrypted in
`localStorage` so requests can be collected after a browser restart. Receipt
history persists bearer tokens that grant access to receipt status, but never the
created secret's plaintext, decryption key, or link. Same-origin JavaScript
(including an injected script) and access to the browser profile can expose these
stored credentials. This behavior predates the shared storage helper; it is a real
storage limitation, not a false-positive finding for request keys and tokens.

Encrypting these records with a key stored alongside them would not address that
threat. Stronger protection needs a separate unlock secret or a different key
storage/lifecycle design, including migration and recovery behavior. Do not
suppress the storage finding solely because the values stay in the browser.

### Backend Architecture

- `cmd/yopass/`: CLI configuration, encryption, and retrieval.
- `cmd/yopass-server/`: flags, dependency setup, and server lifecycle in separate files.
- `pkg/yopass/`: public client, encryption, identifiers, links, and expiration helpers.
- `pkg/server/server.go`: server configuration and route registration.
- `pkg/server/secret.go`, `server_stream.go`, `request.go`, `receipt.go`: endpoint lifecycles.
- `pkg/server/policy.go`, `validation.go`: shared creation/access rules and input validation.
- `pkg/server/config.go`, `health.go`: configuration and operational endpoints.
- `pkg/server/response.go`, `middleware.go`, `metrics.go`: HTTP response helpers and middleware.
- `pkg/server/database.go`, `redis.go`, `memcached.go`: the storage contract and adapters.
- `pkg/server/filestore_*.go`: encrypted blob storage and expiry cleanup.
- `deploy/cdk/`: a separate Go module containing the Lambda/DynamoDB adapter.

`Database.Status` is non-destructive; `Get` claims one-time values before returning
them. HTTP retrieval uses `GetAuthorized`: the backend reads a snapshot, calls the
authorization callback, and conditionally consumes that same version. Denial or
any intervening write (including an identical-value rewrite) must prevent delivery
and leave the replacement intact. Custom `Database` adapters must implement this
method and `DeleteAuthorized` for explicit deletion of either one-time or
multi-view values; a separate `Status` followed by unconditional `Delete` is not sufficient.
Missing or concurrently replaced values return `ErrKeyNotFound`.

Redis uses `WATCH`/`MULTI`/`EXEC`, as the existing update path does; Lua scripting
permissions (`EVAL`/`EVALSHA`) are not required. Memcached uses CAS with immediate
expiration, and DynamoDB uses a conditional delete against its stored revision.

DynamoDB records without a valid revision are not automatically migrated. One-time
retrieval, authorized deletion, and updates return `ErrKeyNotFound` without
modifying those records. Non-destructive status and authorized multi-view reads
remain available. New writes always receive fresh revisions. When upgrading a
legacy deployment, stop all legacy writers before an offline migration that adds
unique revisions while preserving payloads and absolute TTLs, or allow the legacy
records to expire. A rolling deployment alone does not migrate existing records;
adding revisions while legacy writers are active cannot provide version safety.

### Adding New Features

1. **Security First**: Consider security implications of all changes
2. **Test-Driven Development**: Write tests before implementation
3. **Documentation**: Update relevant documentation
4. **Configuration**: Make features configurable when appropriate
5. **Backward Compatibility**: Maintain API compatibility unless it's a breaking change

### Performance Considerations

- **Frontend**: Use React best practices, avoid unnecessary re-renders
- **Backend**: Consider memory usage and CPU efficiency
- **Crypto**: Ensure cryptographic operations are performed client-side
- **Streaming**: Use streaming for large file uploads/downloads

## I want to help out

Fantastic! Here are ways to contribute:

### Good First Issues
Look for issues tagged with:
- `good first issue` - Perfect for newcomers
- `help wanted` - Ready to be picked up
- `documentation` - Improve docs and guides

### Areas That Need Help
- **Documentation improvements** - Always welcome
- **Test coverage** - Expand test suites
- **Accessibility** - Improve a11y compliance
- **Internationalization** - Add new language translations
- **Performance** - Optimize critical paths
- **Security** - Security audits and improvements

## I need installation help

Yopass is designed to be easy to deploy:

### Docker Deployment (Recommended)
```bash
# Basic setup with docker-compose
cd deploy/
docker-compose up -d
```

### Manual Installation
For custom setups, refer to:
- [README.md](README.md) - Complete installation guide
- [deploy/](deploy/) - Example configurations
- [Documentation](https://yopass.se) - Detailed deployment guides

### Getting Help
- Check existing [GitHub issues](https://github.com/jhaals/yopass/issues)
- Read the [documentation](https://yopass.se)
- Ask questions in GitHub discussions

## Code of Conduct

- Be respectful and inclusive
- Focus on constructive feedback
- Help create a welcoming environment for all contributors
- Follow the [GitHub Community Guidelines](https://docs.github.com/en/site-policy/github-terms/github-community-guidelines)

## Resources

- **Project Documentation**: [README.md](README.md)
- **API Documentation**: Available in the codebase
- **Issue Tracker**: [GitHub Issues](https://github.com/jhaals/yopass/issues)

---

Thank you for contributing to Yopass! Your efforts help make secure secret sharing accessible to everyone. 🔐

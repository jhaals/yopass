# How to contribute to Yopass

First of all, thank you for taking the time to contribute to Yopass! 🎉

## Getting Started

### Prerequisites

**Backend Development (Go):**
- Go 1.21+
- Redis or Memcached for storage
- Git

**Frontend Development (React/TypeScript):**
- Node.js 18+
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
   go run cmd/yopass-server/main.go --redis=redis://localhost:6379/0
   ```

3. **Frontend setup:**
   ```bash
   cd website/
   yarn install
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

# Lint (install golangci-lint first)
golangci-lint run

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

# Run end-to-end tests
yarn test

```

**Backend Testing:**
```bash
# Run all tests
go test ./...

# Run tests with coverage
go test -cover ./...

# Run specific package tests
go test ./pkg/server/...
```

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
- [ ] **Linting passes** - `yarn lint` (frontend) and `golangci-lint run` (backend)
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

The frontend follows a modern React architecture:

```
src/
├── app/           # Main application setup
├── features/      # Feature-based components
├── shared/        # Reusable utilities and components
│   ├── components/  # UI components
│   ├── hooks/       # Custom React hooks
│   ├── lib/         # Utility functions
│   └── types/       # TypeScript type definitions
└── tests/         # Test utilities
```

### Backend Architecture

The backend uses a clean architecture pattern:

```
cmd/               # CLI applications
pkg/
├── server/        # HTTP server and routing
├── yopass/        # Core business logic
└── ...           # Other packages
```

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

# BoardDocs Crawler

## Overview

This is a web scraping application that crawls BoardDocs websites to download meeting documents and agendas from school district boards. The system consists of a React-based frontend for user interaction and a Node.js backend that handles the actual web crawling using headless browsers (Playwright/Puppeteer). The crawler navigates through BoardDocs sites, extracts document links, and downloads files to the local filesystem, providing real-time progress updates via Server-Sent Events (SSE).

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Monorepo Structure
The application is organized as a monorepo with two main workspaces:
- **`/web`** - Frontend React application
- **`/server`** - Backend Node.js crawler service

Each workspace maintains its own package.json and dependencies, allowing independent development and deployment.

### Frontend Architecture (React + Vite)

**Technology Stack:**
- React 19 for UI components
- Vite as the build tool and development server
- ES Modules (ESM) for modern JavaScript
- ESLint for code quality

**Key Design Decisions:**
1. **Vite Development Server** - Chosen for fast hot module replacement and modern build capabilities. Configured to proxy `/api` requests to the backend server (port 3000), enabling seamless local development without CORS issues.

2. **File System Watching** - Extensive ignore patterns configured to prevent Vite from watching large download directories, server code, and cache folders, which would otherwise cause performance issues during development.

3. **Port Configuration** - Frontend runs on port 5000 with `strictPort: true` to ensure consistent development environment and avoid port conflicts.

### Backend Architecture (Node.js + Express)

**Technology Stack:**
- Express 5 for HTTP server
- ES Modules for modern JavaScript patterns
- EventEmitter for real-time job progress tracking
- File system operations via fs-extra

**Key Design Decisions:**

1. **Job-Based Architecture** - Crawl operations are treated as asynchronous jobs with unique IDs. Jobs are stored in-memory using a Map, where each job has an EventEmitter for publishing progress events. This allows multiple concurrent crawl operations.

2. **Server-Sent Events (SSE)** - Real-time progress updates delivered via `/api/crawl/stream` endpoint. This was chosen over WebSockets for simplicity and because communication is unidirectional (server to client).

3. **Fire-and-Forget Pattern** - The `/api/crawl` endpoint immediately returns a job ID, then executes the crawl asynchronously. This prevents HTTP timeout issues for long-running operations.

### Web Scraping Engine

**Browser Automation Stack:**
- Playwright (primary) for modern browser automation
- Puppeteer (secondary/backup) for alternative headless browser control
- Cheerio for HTML parsing and DOM manipulation
- Undici for high-performance HTTP requests

**Key Design Decisions:**

1. **Dual Browser Support** - Both Playwright and Puppeteer are included, providing flexibility and redundancy. Playwright is preferred for its better cross-browser support and more stable API.

2. **HTTP Connection Pooling** - Custom Undici Agent configured with keep-alive connections (256 max sockets, 60s timeout) to maximize download throughput when fetching documents. This significantly improves performance when downloading many files.

3. **Concurrency Control** - p-queue library manages concurrent operations to prevent overwhelming target servers and avoid rate limiting or IP bans.

4. **Safe File System Operations** - The crawler includes directory resolution (handles `~` expansion, absolute paths) and writability checks before starting downloads. Files are organized by district in configurable output directories.

5. **Error Handling** - The crawler emits structured events (log, progress, file, summary) through EventEmitters, allowing the API layer to stream these to clients. Fatal errors are caught and reported through the same event system.

### State Management

**In-Memory Job Store:**
- No database required for core functionality
- Jobs Map stores active crawl operations
- EventEmitter instances provide real-time event streaming
- Simple garbage collection strategy: jobs persist in memory until server restart

**Trade-offs:**
- **Pro:** Simple, no external dependencies, fast access
- **Con:** Jobs lost on server restart, memory grows with long-running jobs
- **Alternative Considered:** Redis or similar for persistence, rejected for simplicity and because crawl jobs are typically short-lived

### Configuration Management

**Environment-Based:**
- Output directories configurable per crawl job
- Default: `downloads_{district}` in current working directory
- Server ports hardcoded but easily extracted to environment variables if needed

## External Dependencies

### Browser Automation
- **Playwright** (v1.56.1) - Primary headless browser automation framework
- **Puppeteer** (v24.27.0 root, v21.0.0 server) - Secondary browser automation option

### HTTP & Networking
- **Undici** (v7.16.0) - High-performance HTTP client with connection pooling
- **Express** (v5.1.0) - Web server framework

### HTML Processing
- **Cheerio** (v1.1.2) - Fast, flexible HTML parsing and manipulation

### Concurrency & Performance
- **p-queue** (v9.0.0) - Promise-based queue for concurrency control

### File System
- **fs-extra** (v11.3.2) - Enhanced file system operations with promise support

### Event Handling
- **events** (v3.3.0) - EventEmitter for real-time progress tracking

### Frontend Build Tools
- **Vite** (v7.1.7) - Fast build tool and dev server
- **@vitejs/plugin-react** - React integration for Vite
- **ESLint** - Code quality and linting

### Runtime Requirements
- **Node.js** >= 18 (specified in server/package.json)
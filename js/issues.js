/**
 * GitHub Issues Manager
 * Advanced issue tracking and management for ModelEarth repositories
 * 
 * Note: Uses 'modelearth' (lowercase) as GitHub user account to avoid 
 * organization OAuth requirements that would cause 401 authentication errors.
 */

/*
// This was in team rather than team/projects.
// Let's place this here instead and use minimal parameter to invoke from projects, projects/hub and team/projects

    // Initialize Projects Hub widget in minimal auth-only mode
    let githubAuthWidget;

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGitHubAuth);
    } else {
        initGitHubAuth();
    }

    function initGitHubAuth() {
        try {
            // Create minimal widget for auth only
            githubAuthWidget = new GitHubIssuesManager('github-auth-minimal', {
                githubToken: localStorage.getItem('github_token') || '',
                owner: 'modelearth',
                defaultRepo: 'team'
            });

            // Make it globally accessible
            window.issuesManager = githubAuthWidget;

            console.log('✅ GitHub Auth widget initialized (minimal mode)');
        } catch (error) {
            console.error('❌ Failed to initialize GitHub Auth widget:', error);
        }
    }
*/

class GitHubIssuesManager {
    constructor(containerId = 'issuesWidget', options = {}) {
        this.containerId = containerId;

        // Read configuration from data attributes or options
        const container = document.getElementById(containerId);
        const config = this.parseConfiguration(container, options);

        this.githubToken = localStorage.getItem('github_token') || '';
        console.log('🔑 Token from localStorage:', this.githubToken ? '✅ Found (length: ' + this.githubToken.length + ')' : '❌ Not found');
        this.baseURL = 'https://api.github.com';
        this.owner = config.githubOwner;
        this.detectCurrentFolder = config.detectCurrentFolder;
        this.multiRepoRoots = config.multiRepoRoots;
        this.currentFolder = this.getCurrentFolder();
        this.defaultRepo = this.determineDefaultRepo();

        this.perPage = 10;
        this.currentPage = 1;
        this.allIssues = [];
        this.filteredIssues = [];
        this.repositories = [];
        this.repositoryIssues = {}; // Cache for repository-specific issues
        this.repositoryIssueCounts = {}; // Cache for repository issue counts
        this.loadedAllRepositories = false; // Track if we've loaded all repos or just primary ones
        this.totalRepositoryCount = null; // Cache total repo count for UI display
        this.lastRefreshTime = null;
        this.autoRefreshInterval = null;
        this.assignees = new Set();
        this.labels = new Set();

        // Cache configuration (in minutes)
        this.cacheConfig = {
            duration: parseInt(localStorage.getItem('github_cache_duration')) || 10, // Default 10 minutes
            autoRefresh: localStorage.getItem('github_cache_auto_refresh') !== 'false' // Default true
        };
        this.cacheExpireTimer = null;
        this.rateLimitInfo = {
            remaining: null,
            resetTime: null,
            startTime: null
        };
        this.invalidTokenWarningShown = false; // Track if invalid token warning has been shown
        this.rateLimitWarningShown = false; // Track if rate limit warning has been shown

        // State management
        this.filters = {
            repo: this.defaultRepo,
            sort: 'updated',
            assignee: 'all',
            projectstatus: 'open',
            label: 'all',
            search: ''
        };

        // UI state
        this.currentView = 'short'; // Default view
        this.isFullscreen = false;
        this.currentRefreshIssueId = null;

        // Minimal mode - only show GitHub token auth section
        this.minimalMode = options.minimalMode || false;

        // Search debouncing
        this.searchDebounceTimer = null;
        this.searchDebounceDelay = 300; // 300ms delay

        this.init();
    }

    parseConfiguration(container, options) {
        const config = {
            githubOwner: 'modelearth',
            detectCurrentFolder: true,
            multiRepoRoots: ['webroot', 'modelearth']
        };

        // Read from data attributes if container exists
        if (container) {
            if (container.dataset.githubOwner) {
                config.githubOwner = container.dataset.githubOwner;
            }
            if (container.dataset.detectCurrentFolder) {
                config.detectCurrentFolder = container.dataset.detectCurrentFolder === 'true';
            }
            if (container.dataset.multiRepoRoots) {
                config.multiRepoRoots = container.dataset.multiRepoRoots.split(',').map(s => s.trim());
            }
        }

        // Override with explicit options
        return { ...config, ...options };
    }

    getCurrentFolder() {
        // Get current folder from URL path
        const path = window.location.pathname;
        const pathParts = path.split('/').filter(part => part.length > 0);

        // Return the first non-empty path segment (top-level folder)
        return pathParts.length > 0 ? pathParts[0] : '';
    }

    getHubPath() {
        // Determine the correct path to hub/repos.csv based on the script's location
        const scripts = document.getElementsByTagName('script');
        for (let script of scripts) {
            if (script.src && script.src.includes('issues.js')) {
                const srcAttribute = script.getAttribute('src');
                // If script src starts with ../js/ (from hub directory)
                if (srcAttribute && srcAttribute.startsWith('../js/')) {
                    return 'repos.csv';
                }
                // If script src is js/issues.js (from projects directory)
                else if (srcAttribute && srcAttribute === 'js/issues.js') {
                    return 'hub/repos.csv';
                }
                break;
            }
        }

        // Fallback: climb out of js folder and into hub folder
        return '../hub/repos.csv';
    }

    determineDefaultRepo() {
        if (!this.detectCurrentFolder) {
            return 'projects'; // Default fallback
        }

        // Always default to 'projects' repo for ModelEarth instead of loading all repos
        if (this.multiRepoRoots.includes(this.currentFolder)) {
            return 'projects';
        }

        // If current folder exists and is not a multi-repo root, use it as default
        if (this.currentFolder) {
            return this.currentFolder;
        }

        // Fallback to 'projects' if no folder detected
        return 'projects';
    }

    // Widget HTML template methods
    createWidgetStructure() {
        const container = document.getElementById(this.containerId);
        if (!container) {
            console.error(`Container with id '${this.containerId}' not found`);
            return;
        }

        // In minimal mode, only render the header (auth section)
        if (this.minimalMode) {
            container.innerHTML = `${this.createHeaderHTML()}`;
            return;
        }

        // Normal mode - render everything
        container.innerHTML = `
            ${this.createHeaderHTML()}
            ${this.createRateLimitHTML()}
            ${this.createLoadingOverlayHTML()}
            ${this.createFiltersHTML()}
            ${this.createIssuesContainerHTML()}
            ${this.createStatsHTML()}
            ${this.createCacheStatusHTML()}
            ${this.createErrorHTML()}
            ${this.createModalHTML()}
        `;
    }

    createHeaderHTML() {
        // In minimal mode, skip the h1 header and fullscreen button
        if (this.minimalMode) {
            return `
                <div class="issues-header">
                    <div class="header-content">
                        <div id="github-token-fields">
                            <p class="subtitle">
                                <a href="#" id="toggleTokenSection" class="token-toggle-link" style="font-size: 0.9rem;">Add Your GitHub Token</a>
                                <span id="tokenBenefitText" style="font-size: 0.9rem;"> to increase API rate limits from 60 to 5,000 requests per hour</span>
                                <span id="headerLastRefreshTime" style="font-size: 0.9rem; display: none;"> Issue counts last updated: <span id="headerRefreshTime">Never</span>.</span>
                                <span id="gitAccountDisplay" style="font-size: 0.9rem; display: none;"> GitHub: <a href="#" id="gitAccountLink" onclick="toggleGitIssuesAccount(); return false;"></a></span>
                            </p>
                            <p class="subtitle" style="margin-top: 5px;">
                                <input type="text" id="gitIssuesAccount" class="textInput" style="width:150px; font-size: 14px; display: none;" placeholder="GitHub Account" onfocus="this.select()" oninput="updateGitIssuesAccount()">
                            </p>
                        </div>
                    </div>

                    <!-- GitHub Authentication -->
                    <div class="auth-section" id="authSection" style="display: none;">
                        <div class="auth-input">
                            <input type="password" id="githubToken" placeholder="Enter GitHub Personal Access Token (optional for public repos)">
                            <button id="saveToken" class="btn btn-primary">
                                <i class="fas fa-save"></i> Save Token
                            </button>
                            <button id="clearToken" class="btn btn-primary" style="display: none;">
                                Clear
                            </button>
                        </div>
                        <div class="auth-help">
                            <i class="fas fa-info-circle"></i>
                            <span><strong>Token Benefits:</strong> Access private repositories and higher rate limits.</span>
                        </div>
                        <div class="auth-instructions">
                            <details>
                                <summary>
                                    <span><i class="fas fa-question-circle"></i> How to create a GitHub token?</span>
                                    <a href="https://github.com/settings/tokens/new?description=ModelEarth+Projects+Hub&scopes=repo,read:org" target="_blank" class="token-link">
                                        <i class="fas fa-external-link-alt"></i> Get Your Token
                                    </a>
                                </summary>
                                <div class="instructions-content">
                                    <ol>
                                        <li>Click the "Get Your Token" link above (opens GitHub)</li>
                                        <li>You'll be taken to GitHub's token creation page with recommended settings</li>
                                        <li>Add a description like "ModelEarth Projects Hub"</li>
                                        <li>Select scopes: <code>repo</code> (for private repos) and <code>read:org</code> (for organization data)</li>
                                        <li>Click "Generate token" at the bottom</li>
                                        <li>Copy the generated token immediately (you won't see it again!)</li>
                                        <li>Paste it in the field above and click "Save Token"</li>
                                    </ol>
                                    <p class="note">
                                        <i class="fas fa-shield-alt"></i>
                                        <strong>Security:</strong> Tokens are stored locally in your browser only. Never share your token with others.
                                    </p>
                                </div>
                            </details>
                        </div>
                    </div>
                </div>
            `;
        }

        // Normal mode - full header with h1 and fullscreen button
        return `
            <div class="issues-header">
                <i class="fas fa-expand header-fullscreen-btn" onclick="issuesManager.toggleFullscreen()" title="Toggle Fullscreen"></i>

                <div class="header-content">
                    <h1 style="font-size:32px"><i class="fab fa-github"></i> Team Projects</h1>
                    <div id="github-token-fields">
                        <p class="subtitle">
                            <a href="#" id="toggleTokenSection" class="token-toggle-link" style="font-size: 0.9rem;">Add Your GitHub Token</a>
                            <span id="tokenBenefitText" style="font-size: 0.9rem;"> to increase API rate limits from 60 to 5,000 requests per hour</span>
                            <span id="headerLastRefreshTime" style="font-size: 0.9rem; display: none;"> Issue counts last updated: <span id="headerRefreshTime">Never</span>.</span>
                            <span id="gitAccountDisplay" style="font-size: 0.9rem; display: none;"> GitHub: <a href="#" id="gitAccountLink" onclick="toggleGitIssuesAccount(); return false;"></a></span>
                        </p>
                        <p class="subtitle" style="margin-top: 5px;">
                            <input type="text" id="gitIssuesAccount" class="textInput" style="width:150px; font-size: 14px; display: none;" placeholder="GitHub Account" onfocus="this.select()" oninput="updateGitIssuesAccount()">
                        </p>
                    </div>
                     <span>
       <a class="token-toggle-link" style="font-size:0.9rem;" href="/team/projects/#list=modelteam">Team Members</a>
         </span>
                </div>

                <!-- GitHub Authentication -->
                <div class="auth-section" id="authSection" style="display: none;">
                    <div class="auth-input">
                        <input type="password" id="githubToken" placeholder="Enter GitHub Personal Access Token (optional for public repos)">
                        <button id="saveToken" class="btn btn-primary">
                            <i class="fas fa-save"></i> Save Token
                        </button>
                        <button id="clearToken" class="btn btn-primary" style="display: none;">
                            Clear
                        </button>
                    </div>
                    <div class="auth-help">
                        <i class="fas fa-info-circle"></i>
                        <span><strong>Token Benefits:</strong> Access private repositories and higher rate limits.</span>
                    </div>
                    <div class="auth-instructions">
                        <details>
                            <summary>
                                <span><i class="fas fa-question-circle"></i> How to create a GitHub token?</span>
                                <a href="https://github.com/settings/tokens/new?description=ModelEarth+Projects+Hub&scopes=repo,read:org" target="_blank" class="token-link">
                                    <i class="fas fa-external-link-alt"></i> Get Your Token
                                </a>
                            </summary>
                            <div class="instructions-content">
                                <ol>
                                    <li>Click the "Get Your Token" link above (opens GitHub)</li>
                                    <li>You'll be taken to GitHub's token creation page with recommended settings</li>
                                    <li>Add a description like "ModelEarth Projects Hub"</li>
                                    <li>Select scopes: <code>repo</code> (for private repos) and <code>read:org</code> (for organization data)</li>
                                    <li>Click "Generate token" at the bottom</li>
                                    <li>Copy the generated token immediately (you won't see it again!)</li>
                                    <li>Paste it in the field above and click "Save Token"</li>
                                </ol>
                                <p class="note">
                                    <i class="fas fa-shield-alt"></i>
                                    <strong>Security:</strong> Tokens are stored locally in your browser only. Never share your token with others.
                                </p>
                            </div>
                        </details>
                    </div>
                </div>
            </div>
        `;
    }

    createRateLimitHTML() {
        return `
            <div id="rateLimitInfo" class="rate-limit-info" style="display: none;">
                <!-- Rate limit information will be displayed here -->
            </div>
        `;
    }

    createLoadingOverlayHTML() {
        return `
            <div class="loading-overlay" id="loadingOverlay">
                <div class="loading-spinner">
                    <div class="spinner"></div>
                    <p>Loading GitHub data...</p>
                    <div class="loading-progress">
                        <div class="progress-bar" id="progressBar"></div>
                    </div>
                    <p class="loading-status" id="loadingStatus">Fetching repositories...</p>
                </div>
            </div>
        `;
    }

    createFiltersHTML() {
        return `
            <!-- Always visible filters row -->
            <div class="filters-always-visible">
                <!-- First row: View controls and repo filter -->
                <div class="filter-row-1">
                    <!-- View Controls (moved from issues container) -->
                    <div class="filter-group">
                        <select id="repoFilter" class="filter-select">
                            <option value="all">All Repositories</option>
                        </select>
                    </div>
                    <div class="view-controls">
                        <div class="view-toggle">
                            <button id="shortView" class="view-btn active" title="Short View">
                                <i class="fas fa-align-justify"></i>
                            </button>
                            <button id="listView" class="view-btn" title="List View">
                                <i class="fas fa-list"></i>
                            </button>
                            <button id="cardView" class="view-btn" title="Card View">
                                <i class="fas fa-th-large"></i>
                            </button>
                        </div>
                    </div>
                </div>
                
                <!-- Second row: Remaining 4 elements -->
                <div class="filter-row-2">
                    <!-- State Filter (moved from secondary row) -->
                    <div class="filter-group">
                        <button id="stateButton" class="filter-button compact-filter">
                            <i class="fas fa-exclamation-circle"></i> Active
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="dropdown-menu" id="stateDropdown">
                            <div class="dropdown-item" data-projectstatus="open">
                                <i class="fas fa-exclamation-circle"></i> Active
                            </div>
                            <div class="dropdown-item" data-projectstatus="closed">
                                <i class="fas fa-check-circle"></i> Closed
                            </div>
                            <div class="dropdown-item" data-projectstatus="all">
                                <i class="fas fa-list"></i> All
                            </div>
                        </div>
                    </div>
                    
                    <!-- Labels Filter (moved from secondary row) -->
                    <div class="filter-group">
                        <button id="labelButton" class="filter-button compact-filter">
                            <i class="fas fa-tags"></i> Labels: All
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="dropdown-menu" id="labelDropdown">
                            <div class="dropdown-item" data-label="all">
                                <i class="fas fa-tags"></i> All Labels
                            </div>
                        </div>
                    </div>
                    
          <button id="toggleFiltersBtn" class="toggle-filters-btn" title="Toggle Additional Filters" onclick="console.log('Container width:', this.closest('.filters-always-visible')?.offsetWidth + 'px');">
                        <i class="fas fa-filter toggle-icon" style="display: none;"></i>
                        <span class="toggle-text">More Filters</span>
                    </button>
                    
                    <button id="clearAllFiltersBtn" class="btn btn-secondary clear-filters-btn" style="display: none;">
                        <i class="fas fa-times clear-icon" style="display: none;"></i>
                        <span class="clear-text">Clear</span>
                    </button>
                </div>
            </div>

            <!-- Collapsible additional filters section -->
            <div class="filters-section" id="filtersSection" style="display: none;">
                <!-- Additional filter buttons -->
                <div class="filters-row filters-secondary-row additional-filters">
                    <!-- Assigned to filter (moved from main row) -->
                    <div class="filter-group">
                        <button id="assigneeButton" class="filter-button">
                            <i class="fas fa-user"></i> Assigned to: All
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="dropdown-menu" id="assigneeDropdown">
                            <div class="dropdown-item" data-assignee="all">
                                <i class="fas fa-users"></i> All Users
                            </div>
                            <div class="dropdown-item" data-assignee="unassigned">
                                <i class="fas fa-user-slash"></i> Unassigned
                            </div>
                        </div>
                    </div>

                    <!-- Sort filter (moved from main row) -->
                    <div class="filter-group">
                        <button id="sortButton" class="filter-button">
                            <i class="fas fa-sort"></i> Sort by: Updated
                            <i class="fas fa-chevron-down"></i>
                        </button>
                        <div class="dropdown-menu" id="sortDropdown">
                            <div class="dropdown-item" data-sort="updated">
                                <i class="fas fa-calendar-alt"></i> Updated Date
                            </div>
                            <div class="dropdown-item" data-sort="created">
                                <i class="fas fa-plus"></i> Created Date
                            </div>
                            <div class="dropdown-item" data-sort="comments">
                                <i class="fas fa-comments"></i> Comment Count
                            </div>
                            <div class="dropdown-item" data-sort="title">
                                <i class="fas fa-sort-alpha-down"></i> Title (A-Z)
                            </div>
                            <div class="dropdown-item" data-sort="number">
                                <i class="fas fa-hashtag"></i> Issue Number
                            </div>
                        </div>
                    </div>
                    
                    <div class="filter-group" style="margin-left: auto;">
                        <button id="clearCacheButton" class="btn btn-secondary">
                            Clear Cache
                        </button>
                    </div>
                </div>

                <!-- Search row -->
                
                <!-- Third row: Search -->
<div class="filter-row-3">
  <div class="search-container">
    <div class="search-group">
      <input id="searchInput" type="text" placeholder="Enter Search " />
      <button id="searchButton" class="btn btn-primary">
        <i class="fas fa-search"></i>
      </button>
      <button id="clearSearch" class="btn btn-clear-search" title="Clear" style="display:none">
        <i class="fas fa-times"></i>
      </button>
    </div>
  </div>

  <!-- NEW: live counts -->
  <div class="search-stats" id="searchStats" aria-live="polite"></div>
</div>

            </div>
        `;
    }

    createIssuesContainerHTML() {
        return `
            <div class="issues-container" id="issuesContainer" style="display: none;">
                
                <div class="issues-list" id="issuesList">
                    <!-- Issues will be dynamically loaded here -->
                </div>

                <!-- Pagination -->
                <div class="pagination-container" id="paginationContainer">
                    <div class="pagination-info">
                        <span id="paginationInfo">Showing 0 of 0 issues</span>
                    </div>
                    <div class="pagination-controls" id="paginationControls">
                        <!-- Pagination buttons will be generated here -->
                    </div>
                </div>
            </div>
        `;
    }

    createStatsHTML() {
        return `
            <div class="stats-section" id="statsSection" style="display: none;">
                <div class="stat-card">
                    <div class="stat-icon">
                        <i class="fas fa-code-branch"></i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="repoCount">0</div>
                        <div class="stat-label">Repositories</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">
                        <i class="fas fa-exclamation-circle"></i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="openIssueCount">0</div>
                        <div class="stat-label">Open Issues</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">
                        <i class="fas fa-check-circle"></i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="closedIssueCount">0</div>
                        <div class="stat-label">Closed Issues</div>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon">
                        <i class="fas fa-comments"></i>
                    </div>
                    <div class="stat-content">
                        <div class="stat-number" id="totalComments">0</div>
                        <div class="stat-label">Comments</div>
                    </div>
                </div>
            </div>
        `;
    }

    createCacheStatusHTML() {
        return `
            <div class="cache-status-section">
                <div id="cacheStatus" class="cache-status">
                    <span class="cache-info">Cache: Loading...</span>
                </div>
            </div>
        `;
    }

    createErrorHTML() {
        return `
            <div class="error-message" id="errorMessage" style="display: none;">
                <div class="error-icon">
                    <i class="fas fa-exclamation-triangle"></i>
                </div>
                <div class="error-content">
                    <h3>Error Loading Issues</h3>
                    <p id="errorText">Failed to load GitHub data. Please check your connection and try again.</p>
                    <button id="retryButton" class="btn btn-primary">
                        <i class="fas fa-redo"></i> Retry
                    </button>
                </div>
            </div>
        `;
    }

    createModalHTML() {
        return `
            <div class="modal-overlay" id="issueModal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h2 id="modalTitle">Issue Details</h2>
                        <button class="modal-close" id="modalClose">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body" id="modalBody">
                        <!-- Issue details will be loaded here -->
                    </div>
                </div>
            </div>
            
            <!-- Refresh Dialog -->
            <div class="modal-overlay" id="refreshDialog" style="display: none;">
                <div class="modal-content" style="max-width: 400px;">
                    <div class="modal-header">
                        <h2 id="refreshDialogTitle">Refresh Issue</h2>
                        <button class="modal-close" id="refreshDialogClose">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                    <div class="modal-body">
                        <p>Do you want to refresh this issue with the latest data from GitHub?</p>
                        <div class="refresh-dialog-actions" style="margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end;">
                            <button class="btn btn-secondary" id="refreshDialogCancel">Cancel</button>
                            <button class="btn btn-primary" id="refreshDialogConfirm">
                                <i class="fas fa-sync-alt"></i> Refresh Issue
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    async init() {
        // Create the widget structure first
        this.createWidgetStructure();

        // In minimal mode, only setup auth-related functionality
        if (this.minimalMode) {
            // Setup only auth event listeners
            this.setupAuthEventListeners();
            // Update token UI to show/hide clear button
            this.updateTokenUI();
            // Update toggle link text and benefit text based on token presence
            this.updateTokenSectionUI();
            console.log('✅ Minimal mode init complete - auth section only');
            return;
        }

        // Normal mode - full initialization
        // Ensure initial responsive state is correct
        this.updateAssigneeButton();
        this.updateToggleButtonDisplay();

        this.setupEventListeners();
        this.setupMenuClickHandler(); // Add menu click handler
        this.loadFromHash();
        this.loadFromCache();
        this.updateTokenUI();

        // Load saved view preference
        this.loadViewPreference();

        // Auto-detect owner from current URL or default to ModelEarth
        this.detectOwner();

        // Load rate limit info from cache
        this.loadRateLimitFromCache();

        // If we have a token but no recent rate limit info, clear it to get fresh data
        if (this.githubToken && this.rateLimitInfo.remaining !== null) {
            const now = Date.now();
            const resetTime = new Date(this.rateLimitInfo.resetTime).getTime();
            // If reset time has passed, clear the old info
            if (now > resetTime) {
                this.clearRateLimit();
            }
        }

        this.startRateLimitTimer();

        await this.loadData();

        // Start auto-refresh timer only if we have a token
        if (this.githubToken) {
            this.startAutoRefreshTimer();
        } else {
        }

        // Add resize observer to handle responsive label changes
        this.setupResizeObserver();
    }

    updateSearchStatus() {
        const el = document.getElementById('searchStats');
        if (!el) return;

        // filters considered "active" when anything differs from defaults OR a search term exists
        const defaults = { sort: 'updated', assignee: 'all', projectstatus: 'open', label: 'all' };
        const anyNonDefault = Object.keys(defaults).some(k => this.filters[k] !== defaults[k]);
        const active = anyNonDefault || (this.filters.search && this.filters.search.trim().length > 0);

        if (!active) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }

        const count = this.filteredIssues?.length ?? 0;
        const project = this.allIssues?.length ?? 0;

        // repos shown → if 'all', count unique repos in CURRENT filtered set; else it's 1
        let repo = 1;
        if (this.filters.repo === 'all') {
            const s = new Set((this.filteredIssues || []).map(i => i.repository));
            repo = s.size || (this.repositoryIssueCounts ? Object.keys(this.repositoryIssueCounts).length : 1);
        }

        el.textContent = `${count} matches out of ${project} projects in ${repo} repos`;
        el.style.display = 'block';
    }


    setupResizeObserver() {
        // Create a resize observer to watch the filter container width
        if (typeof ResizeObserver !== 'undefined') {
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    // Update assignee button when container width changes
                    this.updateAssigneeButton();
                    this.updateToggleButtonDisplay();
                }
            });

            // Start observing the filters container
            const container = document.querySelector('.filters-always-visible');
            if (container) {
                observer.observe(container);
            }
        } else {
            // Fallback for browsers without ResizeObserver support
            window.addEventListener('resize', () => {
                this.updateAssigneeButton();
                this.updateToggleButtonDisplay();
            });
        }
    }

    updateToggleButtonDisplay() {
        const container = document.querySelector('.filters-always-visible');
        const toggleBtn = document.getElementById('toggleFiltersBtn');
        const clearBtn = document.getElementById('clearAllFiltersBtn');

        if (container && toggleBtn) {
            const isNarrow = container.offsetWidth < 600;

            // Toggle classes for narrow container
            toggleBtn.classList.toggle('narrow-container', isNarrow);
            if (clearBtn) {
                clearBtn.classList.toggle('narrow-container', isNarrow);
            }

            // Show/hide icons and text based on container width
            const toggleIcon = toggleBtn.querySelector('.toggle-icon');
            const toggleText = toggleBtn.querySelector('.toggle-text');
            const clearIcon = clearBtn?.querySelector('.clear-icon');
            const clearText = clearBtn?.querySelector('.clear-text');

            if (isNarrow) {
                // Show icons, hide text
                if (toggleIcon) toggleIcon.style.display = 'inline';
                if (toggleText) toggleText.style.display = 'none';
                if (clearIcon) clearIcon.style.display = 'inline';
                if (clearText) clearText.style.display = 'none';
            } else {
                // Show text, hide icons
                if (toggleIcon) toggleIcon.style.display = 'none';
                if (toggleText) toggleText.style.display = 'inline';
                if (clearIcon) clearIcon.style.display = 'none';
                if (clearText) clearText.style.display = 'inline';
            }
        }
    }

    detectOwner() {
        // Try to detect owner from URL or use default
        const hostname = window.location.hostname;
        if (hostname.includes('modelearth') || hostname.includes('model.earth')) {
            this.owner = 'modelearth';
        }
        // Could add more detection logic here
    }

    async loadRepositoriesWithIssues() {

        // Start with projects repo as default and highest priority
        const repositoriesWithIssues = [];
        const csvRepos = await this.loadRepositoriesFromCSV();

        // Always add projects repo first (default selection)
        const projectsRepo = csvRepos.find(repo => repo.repo_name === 'projects');
        if (projectsRepo) {
            repositoriesWithIssues.push({
                name: projectsRepo.repo_name,
                displayName: projectsRepo.display_name,
                description: projectsRepo.description,
                defaultBranch: projectsRepo.default_branch,
                openIssueCount: null, // Will be loaded
                totalIssueCount: null,
                repository_url: `https://github.com/${this.owner}/${projectsRepo.repo_name}`,
                priority: 1 // Highest priority for lazy loading
            });
        }

        // Check other repos for issues (excluding projects since we already added it)
        const otherRepos = csvRepos.filter(repo => repo.repo_name !== 'projects');

        for (const repo of otherRepos) {
            try {
                // Quick check if repo has any open issues (most important for active repos)
                const openCount = await this.getRepositoryIssueCount(repo.repo_name, 'open');

                // For filtering purposes, we only need to know if there are any issues
                // Open issues are sufficient to determine if repo should be included
                if (openCount > 0) {
                    repositoriesWithIssues.push({
                        name: repo.repo_name,
                        displayName: repo.display_name,
                        description: repo.description,
                        defaultBranch: repo.default_branch,
                        openIssueCount: openCount, // Set the known open count
                        totalIssueCount: null, // Will be determined when issues are loaded
                        repository_url: `https://github.com/${this.owner}/${repo.repo_name}`,
                        priority: 2 // Lower priority for lazy loading
                    });
                }
            } catch (error) {
            }
        }

        return repositoriesWithIssues;
    }

    async loadRepositoriesFromCSV() {
        try {
            const response = await fetch(this.getHubPath());
            if (!response.ok) {
                throw new Error(`CSV fetch failed: ${response.status}`);
            }
            const csvText = await response.text();
            const parsed = this.parseCSV(csvText);
            return parsed;
        } catch (error) {
            console.error('Error loading repositories from CSV:', error);
            // Fallback to hardcoded list (updated with additional repositories)
            return [
                { repo_name: 'modelearth', display_name: 'ModelEarth', description: 'Main ModelEarth repository', default_branch: 'master' },
                { repo_name: 'localsite', display_name: 'LocalSite', description: 'Core CSS/JS utilities', default_branch: 'main' },
                { repo_name: 'realitystream', display_name: 'RealityStream', description: 'ML Models and Visualization', default_branch: 'main' },
                { repo_name: 'feed', display_name: 'Feed', description: 'FeedPlayer video/gallery', default_branch: 'main' },
                { repo_name: 'swiper', display_name: 'Swiper', description: 'UI swiper components', default_branch: 'main' },
                { repo_name: 'comparison', display_name: 'Comparison', description: 'Trade Flow tools', default_branch: 'main' },
                { repo_name: 'codechat', display_name: 'CodeChat', description: 'Code chat interface', default_branch: 'main' },
                { repo_name: 'home', display_name: 'Home', description: 'Home page content', default_branch: 'main' },
                { repo_name: 'cloud', display_name: 'Cloud', description: 'Cloud platform tools', default_branch: 'main' },
                { repo_name: 'projects', display_name: 'Projects', description: 'Project showcases', default_branch: 'main' },
                { repo_name: 'team', display_name: 'Team', description: 'Rust REST API for Azure', default_branch: 'main' },
                { repo_name: 'products', display_name: 'Products', description: 'Products frontend and python', default_branch: 'main' },
                { repo_name: 'products-data', display_name: 'Products Data', description: 'Products data output', default_branch: 'main' },
                { repo_name: 'profile', display_name: 'Profile', description: 'Profile frontend analysis', default_branch: 'main' },
                { repo_name: 'exiobase', display_name: 'Exiobase', description: 'Trade flow output to .csv and SQL', default_branch: 'main' },
                { repo_name: 'io', display_name: 'IO', description: 'Input-output analysis', default_branch: 'main' },
                { repo_name: 'useeio.js', display_name: 'USEEIO.JS', description: 'JavaScript footprint tools', default_branch: 'dev' },
                { repo_name: 'useeio-widgets', display_name: 'USEEIO Widgets', description: 'USEEIO React widgets', default_branch: 'master' },
                { repo_name: 'useeio-widgets-without-react', display_name: 'USEEIO Widgets Without React', description: 'USEEIO widgets without React', default_branch: 'master' },
                { repo_name: 'useeiopy', display_name: 'USEEIO Python', description: 'Python USEEIO library', default_branch: 'master' },
                { repo_name: 'useeio_api', display_name: 'USEEIO API', description: 'USEEIO REST API', default_branch: 'master' },
                { repo_name: 'useeio', display_name: 'USEEIO Core', description: 'Core USEEIO model', default_branch: 'master' },
                { repo_name: 'useeior', display_name: 'USEEIO R', description: 'R package for USEEIO', default_branch: 'master' },
                { repo_name: 'useeio-state', display_name: 'USEEIO State', description: 'State-level USEEIO data', default_branch: 'main' },
                { repo_name: 'useeio-json', display_name: 'USEEIO JSON', description: 'USEEIO JSON data', default_branch: 'main' },
                { repo_name: 'mario', display_name: 'Mario', description: 'Multi-regional input-output', default_branch: 'main' },
                { repo_name: 'webroot', display_name: 'Webroot', description: 'PartnerTools webroot', default_branch: 'main' },
                { repo_name: 'data-pipeline', display_name: 'Data Pipeline', description: 'Python data processing pipeline', default_branch: 'main' },
                { repo_name: 'community-data', display_name: 'Community data', description: 'Community-level data outputs', default_branch: 'master' },
                { repo_name: 'community-timelines', display_name: 'Community Timeline', description: 'Timeline data for communities', default_branch: 'main' },
                { repo_name: 'community-zipcodes', display_name: 'Community Zipcodes', description: 'ZIP code level community data', default_branch: 'main' },
                { repo_name: 'community-forecasting', display_name: 'Community Forecasting', description: 'Forecasting frontend', default_branch: 'main' },
                { repo_name: 'dataflow', display_name: 'Data flow', description: 'Data flow NextJS UX', default_branch: 'main' },
            ];
        }
    }

    async detectEntityType() {
        const cacheKey = `github_entity_type_${this.owner}`;
        const cacheTimeKey = `github_entity_type_time_${this.owner}`;

        // Check cache first (valid for 24 hours)
        const cachedType = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedType && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const twentyFourHours = 24 * 60 * 60 * 1000; // 24 hours

            if (age < twentyFourHours) {
                return cachedType;
            }
        }

        // Try to detect if it's an organization or user
        try {
            // First try organization endpoint
            try {
                await this.apiRequest(`/orgs/${this.owner}`);
                localStorage.setItem(cacheKey, 'org');
                localStorage.setItem(cacheTimeKey, Date.now().toString());
                return 'org';
            } catch (orgError) {
                // If org fails, try user endpoint
                try {
                    await this.apiRequest(`/users/${this.owner}`);
                    localStorage.setItem(cacheKey, 'user');
                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                    return 'user';
                } catch (userError) {
                    console.warn(`Could not determine entity type for ${this.owner}, defaulting to user`);
                    localStorage.setItem(cacheKey, 'user');
                    localStorage.setItem(cacheTimeKey, Date.now().toString());
                    return 'user';
                }
            }
        } catch (error) {
            console.warn(`Error detecting entity type for ${this.owner}:`, error);
            return 'user'; // Default fallback
        }
    }

    async loadRepositoriesFromGitHub(specificRepos = null) {
        const isLoadingAll = specificRepos === null;
        const cacheKey = isLoadingAll ? 'github_all_repos' : `github_repos_${specificRepos.join('_')}`;
        const cacheTimeKey = isLoadingAll ? 'github_all_repos_time' : `github_repos_${specificRepos.join('_')}_time`;

        // Check if we have cached data that's less than 1 hour old
        const cachedData = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedData && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

            if (age < oneHour) {
                return JSON.parse(cachedData);
            }
        }

        // Fetch fresh data from GitHub API
        if (!this.githubToken) {
            return null;
        }

        const repos = [];

        if (isLoadingAll) {

            // Detect if this is an organization or user account
            const entityType = await this.detectEntityType();
            const endpoint = entityType === 'org'
                ? `/orgs/${this.owner}/repos`
                : `/users/${this.owner}/repos`;

            let page = 1;
            const perPage = 100;

            while (true) {
                const pageRepos = await this.apiRequest(`${endpoint}?per_page=${perPage}&page=${page}&type=all&sort=name`);

                if (pageRepos.length === 0) break;

                // Add repos that have issues
                const reposWithIssues = pageRepos.filter(repo => repo.has_issues && !repo.archived);
                repos.push(...reposWithIssues.map(repo => ({
                    repo_name: repo.name,
                    display_name: repo.name,
                    description: repo.description || '',
                    default_branch: repo.default_branch || 'main',
                    open_issues_count: repo.open_issues_count,
                    html_url: repo.html_url
                })));

                page++;
                if (pageRepos.length < perPage) break; // Last page
            }

        } else {

            // Fetch specific repositories
            for (const repoName of specificRepos) {
                try {
                    const repo = await this.apiRequest(`/repos/${this.owner}/${repoName}`);
                    if (repo.has_issues && !repo.archived) {
                        repos.push({
                            repo_name: repo.name,
                            display_name: repo.name,
                            description: repo.description || '',
                            default_branch: repo.default_branch || 'main',
                            open_issues_count: repo.open_issues_count,
                            html_url: repo.html_url
                        });
                    }
                } catch (error) {
                    console.warn(`Failed to fetch repository ${repoName}:`, error);
                }
            }

        }

        // Cache the results
        localStorage.setItem(cacheKey, JSON.stringify(repos));
        localStorage.setItem(cacheTimeKey, Date.now().toString());

        return repos;
    }

    async loadAllRepositories() {
        if (this.loadedAllRepositories) {
            return;
        }

        this.updateLoadingStatus('Loading all repositories...');

        try {
            const allRepos = await this.loadRepositoriesFromGitHub(null); // null = load all

            if (allRepos && allRepos.length > 0) {
                this.repositories = allRepos.map(apiRepo => ({
                    name: apiRepo.repo_name,
                    displayName: apiRepo.display_name,
                    description: apiRepo.description,
                    defaultBranch: apiRepo.default_branch,
                    openIssueCount: apiRepo.open_issues_count,
                    totalIssueCount: null,
                    repository_url: apiRepo.html_url || `https://github.com/${this.owner}/${apiRepo.repo_name}`
                }));

                this.loadedAllRepositories = true;

                // Load issue counts for all repositories when explicitly loading all
                await this.loadRepositoryIssueCountsForDisplayed();

                // Update UI
                this.populateRepositoryFilter();
                this.showNotification(`Loaded ${this.repositories.length} repositories`, 'success');
            }
        } catch (error) {
            console.error('Error loading all repositories:', error);
            this.showNotification('Failed to load all repositories', 'error');
        }
    }

    async getRepositoryCount() {
        // Check if we have cached count that's less than 1 hour old
        const cacheKey = 'github_repo_count';
        const cacheTimeKey = 'github_repo_count_time';

        const cachedCount = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedCount && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const oneHour = 60 * 60 * 1000;

            if (age < oneHour) {
                return parseInt(cachedCount);
            }
        }

        if (!this.githubToken) {
            return null;
        }

        try {
            // Detect if this is an organization or user account
            const entityType = await this.detectEntityType();
            const endpoint = entityType === 'org'
                ? `/orgs/${this.owner}`
                : `/users/${this.owner}`;

            const entity = await this.apiRequest(endpoint);
            const totalRepos = entity.public_repos || 0;

            // For more accurate count, make one API call to get first page and total
            const reposEndpoint = entityType === 'org'
                ? `/orgs/${this.owner}/repos`
                : `/users/${this.owner}/repos`;

            const firstPage = await this.apiRequest(`${reposEndpoint}?per_page=1&type=all`);

            // Get the actual count from Link header or estimate based on public_repos
            let actualCount = totalRepos;

            // Filter for repositories with issues enabled (rough estimate)
            if (firstPage && firstPage.length > 0) {
                // Make a small sample to estimate percentage with issues
                const sample = await this.apiRequest(`${reposEndpoint}?per_page=10&type=all`);
                const withIssues = sample.filter(repo => repo.has_issues && !repo.archived).length;
                const percentage = withIssues / sample.length;
                actualCount = Math.round(totalRepos * percentage);
            }


            // Cache the result
            localStorage.setItem(cacheKey, actualCount.toString());
            localStorage.setItem(cacheTimeKey, Date.now().toString());

            return actualCount;
        } catch (error) {
            console.warn('Failed to get repository count:', error);
            return null;
        }
    }

    parseCSV(csvText) {
        const lines = csvText.trim().split('\n');
        const headers = lines[0].split(',');
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',');
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index];
            });
            data.push(row);
        }

        return data;
    }

    loadRateLimitFromCache() {
        try {
            const cached = localStorage.getItem('github_rate_limit_info');
            if (cached) {
                this.rateLimitInfo = JSON.parse(cached);

                // Check if rate limit period has passed
                if (this.rateLimitInfo.resetTime && new Date() > new Date(this.rateLimitInfo.resetTime)) {
                    this.clearRateLimit();
                }
            }
        } catch (error) {
            console.warn('Failed to load rate limit info from cache:', error);
        }
    }

    saveRateLimitToCache() {
        try {
            localStorage.setItem('github_rate_limit_info', JSON.stringify(this.rateLimitInfo));
        } catch (error) {
            console.warn('Failed to save rate limit info to cache:', error);
        }
    }

    clearRateLimit() {
        this.rateLimitInfo = {
            remaining: null,
            resetTime: null,
            startTime: null
        };
        localStorage.removeItem('github_rate_limit_info');
        this.updateRateLimitDisplay();
    }

    // Cache management functions
    setupCacheExpirationTimer(timeUntilExpiration) {
        // Don't set auto-refresh timer without a token
        if (!this.githubToken) {
            return;
        }

        // Clear existing timer
        if (this.cacheExpireTimer) {
            clearTimeout(this.cacheExpireTimer);
        }

        // Set new timer for auto-refresh
        this.cacheExpireTimer = setTimeout(() => {
            this.loadData(true); // Force refresh
        }, timeUntilExpiration);

    }

    updateCacheStatusDisplay() {
        const cacheStatusDiv = document.getElementById('cacheStatus');
        if (!cacheStatusDiv) return;

        const cached = localStorage.getItem('github_issues_cache');
        if (cached) {
            try {
                const data = JSON.parse(cached);
                const cacheAge = Date.now() - data.timestamp;
                const cacheAgeMinutes = Math.round(cacheAge / 60000);
                const remainingMinutes = Math.max(0, this.cacheConfig.duration - cacheAgeMinutes);

                cacheStatusDiv.innerHTML = `
                    <span class="cache-info">
                        Cache: ${cacheAgeMinutes}m old, expires in ${remainingMinutes}m 
                        (${this.cacheConfig.duration}m duration)
                        ${this.cacheConfig.autoRefresh ? ' • Auto-refresh enabled' : ' • Auto-refresh disabled'}
                    </span>
                `;
            } catch (error) {
                cacheStatusDiv.innerHTML = '<span class="cache-info">Cache: Invalid</span>';
            }
        } else {
            cacheStatusDiv.innerHTML = '<span class="cache-info">Cache: Empty</span>';
        }
    }

    setCacheDuration(minutes) {
        this.cacheConfig.duration = Math.max(1, Math.min(60, minutes)); // Limit between 1-60 minutes
        localStorage.setItem('github_cache_duration', this.cacheConfig.duration.toString());

        // Clear existing cache to apply new duration
        localStorage.removeItem('github_issues_cache');
        this.clearRepositoryCache(); // Clear all repository-specific caches

        this.showNotification(`Cache duration set to ${this.cacheConfig.duration} minutes`, 'info');
        this.updateCacheStatusDisplay();

        // Reload data with new cache settings
        this.loadData(true);
    }

    toggleAutoRefresh() {
        this.cacheConfig.autoRefresh = !this.cacheConfig.autoRefresh;
        localStorage.setItem('github_cache_auto_refresh', this.cacheConfig.autoRefresh.toString());

        if (!this.cacheConfig.autoRefresh && this.cacheExpireTimer) {
            clearTimeout(this.cacheExpireTimer);
            this.cacheExpireTimer = null;
        }

        this.showNotification(`Auto-refresh ${this.cacheConfig.autoRefresh ? 'enabled' : 'disabled'}`, 'info');
        this.updateCacheStatusDisplay();
    }

    updateRateLimitDisplay() {
        const rateLimitDiv = document.getElementById('rateLimitInfo');
        if (!rateLimitDiv) return;

        // Always show invalid token message if present
        if (this.invalidTokenMessage) {
            rateLimitDiv.innerHTML = `
                <div class="rate-limit-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <div class="rate-limit-content">
                        <div class="rate-limit-title">Invalid GitHub Token</div>
                        <div class="rate-limit-details">${this.invalidTokenMessage}</div>
                    </div>
                </div>
            `;
            rateLimitDiv.style.display = 'block';
            return; // Don't show rate limit info if token is invalid
        }

        if (this.rateLimitInfo.remaining !== null) {
            const resetTime = new Date(this.rateLimitInfo.resetTime);
            const now = new Date();
            const timeLeft = Math.max(0, resetTime - now);
            const minutesLeft = Math.ceil(timeLeft / 60000);
            const remaining = this.rateLimitInfo.remaining;

            // Show warning when running low on requests, recently hit limit, or no token
            const isLowOnRequests = remaining < 100;
            const isRateLimited = remaining === 0 && timeLeft > 0;
            const isWithoutToken = !this.githubToken && remaining <= 60; // Anonymous limit is 60

            const shouldShowWarning = isLowOnRequests || isRateLimited;
            const shouldShowInfo = isWithoutToken && !isRateLimited;

            if (shouldShowWarning && timeLeft > 0) {
                rateLimitDiv.innerHTML = `
                    <div class="rate-limit-warning">
                        <i class="fas fa-clock"></i>
                        <div class="rate-limit-content">
                            <div class="rate-limit-title">API Rate Limit Warning: ${remaining} requests remaining. Resets in ${minutesLeft} minutes (${resetTime.toLocaleTimeString()})</div>
                        </div>
                    </div>
                `;
                rateLimitDiv.style.display = 'block';
            } else if (shouldShowInfo) {
                // Show informational rate limit for users without token
                rateLimitDiv.innerHTML = `
                    <div class="rate-limit-info-display">
                        <i class="fas fa-info-circle"></i>
                        <div class="rate-limit-content">
                            <div class="rate-limit-title">API Rate Limit: ${remaining} requests remaining (without token). ${timeLeft > 0 ? `Resets in ${minutesLeft} minutes (${resetTime.toLocaleTimeString()})` : 'Resets hourly'}</div>
                        </div>
                    </div>
                `;
                rateLimitDiv.style.display = 'block';
            } else {
                rateLimitDiv.style.display = 'none';
            }
        } else {
            rateLimitDiv.style.display = 'none';
        }

        // Update the header text with current rate limit info
        this.updateTokenSectionUI();
    }

    showInvalidTokenMessage(message) {
        const rateLimitDiv = document.getElementById('rateLimitInfo');
        if (!rateLimitDiv) return;

        // Store the invalid token message to show alongside rate limit info
        this.invalidTokenMessage = `${message}. Please update your token above or remove it to use anonymous access (60 requests/hour).`;

        rateLimitDiv.innerHTML = `
            <div class="rate-limit-warning">
                <i class="fas fa-exclamation-triangle"></i>
                <div class="rate-limit-content">
                    <div class="rate-limit-title">Invalid GitHub Token</div>
                    <div class="rate-limit-details">${this.invalidTokenMessage}</div>
                </div>
            </div>
        `;
        rateLimitDiv.style.display = 'block';
    }

    startRateLimitTimer() {
        // Update rate limit display every minute
        if (this.rateLimitTimer) {
            clearInterval(this.rateLimitTimer);
        }

        this.rateLimitTimer = setInterval(() => {
            this.updateRateLimitDisplay();
        }, 60000); // Update every minute
    }

    // Setup only auth-related event listeners (for minimal mode)
    setupAuthEventListeners() {
        const toggleBtn = document.getElementById('toggleTokenSection');
        const saveBtn = document.getElementById('saveToken');
        const clearBtn = document.getElementById('clearToken');

        if (toggleBtn) {
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleTokenSection();
            });
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', () => this.saveToken());
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearToken());
        }
    }

    setupEventListeners() {
        // Token management
        this.setupAuthEventListeners();

        // Filters
        document.getElementById('repoFilter').addEventListener('change', async (e) => {
            const selectedValue = e.target.value;

            // Handle special load_all option
            if (selectedValue === 'load_all') {
                await this.loadAllRepositories();
                // Reset to the current filter after loading
                e.target.value = this.filters.repo;
                return;
            }


            // Warn user about rate limits when selecting "All Loaded Issues" without token
            if (selectedValue === 'all' && !this.githubToken) {
                const remaining = this.rateLimitInfo.remaining || 60; // Default rate limit without token
                const warning = `⚠️ Warning: Loading all repositories without a GitHub token may exhaust your remaining ${remaining} API requests.\n\nEnter your GitHub Token above for more robust requests (5,000/hour vs 60/hour).\n\nProceed anyway?`;

                if (!confirm(warning)) {
                    // Reset to projects if user cancels
                    e.target.value = 'projects';
                    this.filters.repo = 'projects';
                    return;
                }
            }

            this.filters.repo = selectedValue;
            this.updateHash();
            this.saveToCache();

            // Load issues for the selected repository if not already loaded
            if (this.filters.repo !== 'all' && !this.repositoryIssues[this.filters.repo]) {
                // Check if repository exists in our list, if not try to add it dynamically
                const repoExists = this.repositories.find(r => r.name === this.filters.repo);
                if (!repoExists) {
                    try {
                        await this.addRepositoryDynamically(this.filters.repo);
                    } catch (error) {
                        console.error(`Failed to add repository ${this.filters.repo}:`, error);
                        this.showNotification(`Repository "${this.filters.repo}" not found or has no issues`, 'error');
                        // Reset to projects repo
                        this.filters.repo = 'projects';
                        e.target.value = 'projects';
                        return;
                    }
                }

                await this.loadIssuesForRepository(this.filters.repo);
                this.updateRepositoryDropdownCounts();
            } else if (this.filters.repo === 'all') {
                // Load all repositories that haven't been loaded yet
                const unloadedRepos = this.repositories.filter(repo => !this.repositoryIssues[repo.name]);
                for (const repo of unloadedRepos) {
                    await this.loadIssuesForRepository(repo.name);
                }
                this.updateRepositoryDropdownCounts();
            }

            this.filterAndDisplayIssues();
        });

        // Dropdown menus
        this.setupDropdown('sortButton', 'sortDropdown', (value) => {
            this.filters.sort = value;
            this.updateSortButton();
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();
        });

        this.setupDropdown('assigneeButton', 'assigneeDropdown', (value) => {
            this.filters.assignee = value;
            this.updateAssigneeButton();
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();
        });

        this.setupDropdown('stateButton', 'stateDropdown', async (value) => {
            const previousState = this.filters.projectstatus;
            this.filters.projectstatus = value;
            this.updateStateButton();
            this.updateHash();
            this.saveToCache();

            // If state changed, clear memory cache and reload issues with new state
            if (previousState !== value) {
                this.repositoryIssues = {}; // Clear all cached issues

                // Reload issues for current repository with new state
                if (this.filters.repo !== 'all') {
                    await this.loadIssuesForRepository(this.filters.repo);
                } else {
                    await this.loadIssuesForAllRepositories();
                }
            }

            this.filterAndDisplayIssues();
        });

        this.setupDropdown('labelButton', 'labelDropdown', (value) => {
            this.filters.label = value;
            this.updateLabelButton();
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();
        });

        // Search
        const searchInput = document.getElementById('searchInput');
        const searchButton = document.getElementById('searchButton');
        const clearSearch = document.getElementById('clearSearch');

        searchButton.addEventListener('click', () => {
            this.performSearch();
            this.loadData(true); // Also refresh data like the old refresh button
        });
        clearSearch.addEventListener('click', () => this.clearSearch());
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.performSearch();
        });

        // Add debounced search on input
        searchInput.addEventListener('input', (e) => {
            this.debouncedSearch(e.target.value);
        });

        // Clear all filters button
        document.getElementById('clearAllFiltersBtn').addEventListener('click', () => {
            this.clearAllFilters();
        });

        // Clear cache button
        document.getElementById('clearCacheButton').addEventListener('click', () => {
            this.clearAllCache();
        });

        // Toggle filters button
        document.getElementById('toggleFiltersBtn').addEventListener('click', () => {
            this.toggleFilters();
        });

        // View controls
        document.getElementById('shortView').addEventListener('click', () => this.setView('short'));
        document.getElementById('listView').addEventListener('click', () => this.setView('list'));
        document.getElementById('cardView').addEventListener('click', () => this.setView('card'));

        // Filters expand/collapse - commented out (now using header search button instead)
        // document.getElementById('moreFiltersBtn').addEventListener('click', () => this.expandFilters());
        // document.getElementById('filtersCloseBtn').addEventListener('click', () => this.collapseFilters());

        // Modal
        document.getElementById('modalClose').addEventListener('click', () => this.closeModal());
        document.getElementById('issueModal').addEventListener('click', (e) => {
            if (e.target === document.getElementById('issueModal')) this.closeModal();
        });

        // Refresh Dialog
        document.getElementById('refreshDialogClose').addEventListener('click', () => this.closeRefreshDialog());
        document.getElementById('refreshDialogCancel').addEventListener('click', () => this.closeRefreshDialog());
        document.getElementById('refreshDialogConfirm').addEventListener('click', () => this.confirmRefreshDialog());
        document.getElementById('refreshDialog').addEventListener('click', (e) => {
            if (e.target === document.getElementById('refreshDialog')) this.closeRefreshDialog();
        });

        // Retry button
        document.getElementById('retryButton').addEventListener('click', () => this.loadData(true));

        // Prevent token link from toggling details
        const tokenLinks = document.querySelectorAll('.token-link');
        tokenLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });

        // Hash change listener
        window.addEventListener('hashchange', () => this.loadFromHash());

        // Resize listener to update width display
        window.addEventListener('resize', () => this.updatePagination());
    }

    setupDropdown(buttonId, dropdownId, callback) {
        const button = document.getElementById(buttonId);
        const dropdown = document.getElementById(dropdownId);

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeAllDropdowns();
            dropdown.classList.toggle('show');
        });

        dropdown.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.classList.contains('dropdown-item')) {
                const value = e.target.getAttribute('data-sort') ||
                    e.target.getAttribute('data-assignee') ||
                    e.target.getAttribute('data-state') ||
                    e.target.getAttribute('data-projectstatus') ||
                    e.target.getAttribute('data-label');
                callback(value);
                dropdown.classList.remove('show');
            }
        });

        // Close dropdowns when clicking outside
        document.addEventListener('click', () => {
            dropdown.classList.remove('show');
        });
    }

    closeAllDropdowns() {
        document.querySelectorAll('.dropdown-menu').forEach(dropdown => {
            dropdown.classList.remove('show');
        });
    }

    updateTokenUI() {
        const tokenInput = document.getElementById('githubToken');
        const clearButton = document.getElementById('clearToken');

        console.log('🎨 updateTokenUI called:', {
            hasToken: !!this.githubToken,
            tokenLength: this.githubToken?.length || 0,
            tokenInputExists: !!tokenInput,
            clearButtonExists: !!clearButton
        });

        if (!tokenInput || !clearButton) {
            console.warn('⚠️ updateTokenUI: Elements not found!');
            return;
        }

        if (this.githubToken) {
            tokenInput.value = '••••••••••••••••';
            clearButton.style.display = 'inline-block';
            console.log('✅ Token UI updated: Clear button shown');
        } else {
            tokenInput.value = '';
            clearButton.style.display = 'none';
            console.log('ℹ️ Token UI updated: No token, clear button hidden');
        }
    }

    toggleTokenSection() {
        const authSection = document.getElementById('authSection');
        const subtitleDescription = document.getElementById('subtitleDescription');

        if (authSection.style.display === 'none') {
            // Show the token section
            authSection.style.display = 'block';
            subtitleDescription.style.display = 'block';
        } else {
            // Hide the token section
            authSection.style.display = 'none';
            subtitleDescription.style.display = 'none';
        }
    }

    showTokenSectionAndOpenTab() {
        // First scroll to top and reveal auth section
        const authSection = document.getElementById('authSection');
        const subtitleDescription = document.getElementById('subtitleDescription');

        // Show the token section
        if (authSection) {
            authSection.style.display = 'block';
        }
        if (subtitleDescription) {
            subtitleDescription.style.display = 'block';
        }

        // Scroll to top smoothly to show the auth section
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });

        // Open the token URL in new tab immediately
        window.open('https://github.com/settings/tokens/new?description=ModelEarth+Projects+Hub&scopes=repo,read:org', '_blank');
    }

    updateTokenSectionUI() {
        const toggleLink = document.getElementById('toggleTokenSection');
        const benefitText = document.getElementById('tokenBenefitText');
        const headerRefreshSpan = document.getElementById('headerLastRefreshTime');

        if (this.githubToken) {
            toggleLink.textContent = 'Change or Remove your Github Token';
            let text = ' The token has increased your API rate limits from 60 to 5,000 requests per hour';

            // Add current request count and reset time if available
            if (this.rateLimitInfo.remaining !== null && this.rateLimitInfo.resetTime) {
                const resetTime = new Date(this.rateLimitInfo.resetTime);
                const resetTimeString = resetTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
                text += `. ${this.rateLimitInfo.remaining} requests remaining before ${resetTimeString}`;
            } else if (this.rateLimitInfo.remaining !== null) {
                text += `. ${this.rateLimitInfo.remaining} requests remaining`;
            }

            benefitText.textContent = text;
        } else {
            toggleLink.textContent = 'Add Your GitHub Token';
            benefitText.textContent = ' to increase API rate limits from 60 to 5,000 requests per hour';
        }

        // Always keep refresh time info hidden (now sent to console)
        if (headerRefreshSpan) {
            headerRefreshSpan.style.display = 'none';
        }

        // Update the refresh time display
        this.updateHeaderRefreshDisplay();
    }

    async saveToken() {
        const tokenInput = document.getElementById('githubToken');
        const token = tokenInput.value.trim();

        if (token && token !== '••••••••••••••••') {
            // Validate token contains only ASCII characters (ISO-8859-1)
            // GitHub tokens should only contain alphanumeric characters and underscores
            if (!/^[\x00-\xFF]*$/.test(token)) {
                this.showNotification('Invalid token: Token contains non-ASCII characters. GitHub tokens should only contain letters, numbers, and basic symbols.', 'error');
                console.error('❌ Token validation failed: Contains non-ASCII characters');
                return;
            }

            this.githubToken = token;
            localStorage.setItem('github_token', token);
            localStorage.removeItem('github_issues_cache'); // Clear cache when token changes
            localStorage.removeItem('github_all_repos'); // Clear repo cache to fetch fresh data
            localStorage.removeItem('github_all_repos_time');
            this.clearRepositoryCache(); // Clear all repository-specific caches

            // Clear rate limit info since new token likely has better limits
            this.clearRateLimit();

            // Clear any invalid token message and reset warning flags
            this.invalidTokenMessage = null;
            this.invalidTokenWarningShown = false;
            this.rateLimitWarningShown = false; // Reset rate limit warning when new token is added

            this.showNotification('Token saved successfully', 'success');

            // Check if issues previously failed due to rate limiting and refresh them
            await this.refreshIssuesAfterTokenSave();

            // Reload repositories with new token to populate all available repos
            try {
                await this.loadRepositoriesFromCSVToUI();
                this.populateRepositoryDropdown();
            } catch (error) {
                console.error('Error refreshing repositories after token save:', error);
            }
        }

        this.updateTokenUI();
        this.updateTokenSectionUI();

        // Hide the token section after saving (with null checks)
        const authSection = document.getElementById('authSection');
        const subtitleDescription = document.getElementById('subtitleDescription');
        if (authSection) authSection.style.display = 'none';
        if (subtitleDescription) subtitleDescription.style.display = 'none';
    }

    async refreshIssuesAfterTokenSave() {
        try {
            // Check if we currently have a rate limit exceeded state or error state
            const issuesList = document.getElementById('issuesList');
            const errorMessage = document.getElementById('errorMessage');
            const currentErrorMessage = issuesList ? issuesList.innerHTML : '';
            const hasErrorDisplay = errorMessage && errorMessage.style.display !== 'none';

            const hasRateLimitError = currentErrorMessage.includes('API Rate Limit Exceeded') ||
                currentErrorMessage.includes('rate limit') ||
                currentErrorMessage.includes('no-issues') ||
                hasErrorDisplay ||
                this.allIssues.length === 0;

            // Check if rate limit was previously exceeded (stored in rateLimitInfo)
            const wasRateLimited = this.rateLimitInfo.remaining === 0 ||
                localStorage.getItem('github_rate_limit_exceeded') === 'true';

            // Check if we have no repository data loaded due to rate limiting
            const hasNoRepoData = this.repositories.length === 0;

            if (hasRateLimitError || wasRateLimited || hasNoRepoData) {
                this.showNotification('Refreshing issues with new token...', 'info');

                // Clear any rate limit flags
                localStorage.removeItem('github_rate_limit_exceeded');

                // Force refresh the data now that we have a token
                await this.loadData(true);

                this.showNotification('Issues refreshed successfully!', 'success');
            } else {
            }
        } catch (error) {
            console.error('Error refreshing issues after token save:', error);
            this.showNotification('Issues refreshed, but some data may still be loading', 'warning');
        }
    }

    clearToken() {
        // Show confirmation dialog
        const confirmed = confirm(
            'Are you sure you want to clear your GitHub token?\n\n' +
            'This will:\n' +
            '• Remove your stored token\n' +
            '• Clear cached issue data\n' +
            '• Reduce API rate limit from 5,000 to 60 requests per hour\n\n' +
            'You can always add your token back later.'
        );

        if (confirmed) {
            this.githubToken = '';
            localStorage.removeItem('github_token');
            localStorage.removeItem('github_issues_cache'); // Clear cache when token changes
            this.clearRepositoryCache(); // Clear all repository-specific caches
            this.updateTokenUI();
            this.updateTokenSectionUI();
            this.showNotification('GitHub token cleared successfully', 'info');

            // Hide the token section after clearing
            document.getElementById('authSection').style.display = 'none';
            document.getElementById('subtitleDescription').style.display = 'none';
        }
    }

    async loadData(forceRefresh = false) {
        try {
            this.showLoading(true);
            this.hideError();

            // Check cache first
            if (!forceRefresh) {
                const cached = this.loadFromCache();
                if (cached && cached.repositories && cached.repositories.length > 0 && cached.issues && cached.issues.length > 0) {
                    this.repositories = cached.repositories;

                    // Filter out any invalid issues from cached data
                    const validCachedIssues = cached.issues.filter(issue => this.isValidIssue(issue));
                    this.allIssues = validCachedIssues;

                    // Set initial last_refreshed timestamp for cached issues that don't have it
                    this.allIssues.forEach(issue => {
                        if (!issue.last_refreshed) {
                            issue.last_refreshed = new Date().toISOString();
                        }
                    });

                    // Rebuild assignees and labels from cached data
                    this.assignees = new Set();
                    this.labels = new Set();
                    this.allIssues.forEach(issue => {
                        if (issue.assignees && issue.assignees.length > 0) {
                            issue.assignees.forEach(assignee => this.assignees.add(assignee.login));
                        }
                        if (issue.labels && issue.labels.length > 0) {
                            issue.labels.forEach(label => this.labels.add(label.name));
                        }
                    });

                    this.updateUI();
                    this.showLoading(false);
                    return;
                }
            }

            this.updateLoadingStatus('Loading repositories...');
            await this.loadRepositoriesFromCSVToUI();

            // Load issues for repositories
            if (this.filters.repo !== 'all') {
                // Check if the repository exists in our list
                const repoExists = this.repositories.find(r => r.name === this.filters.repo);
                if (repoExists) {
                    this.updateLoadingStatus(`Loading issues for ${this.filters.repo}...`);
                    await this.loadIssuesForRepository(this.filters.repo);
                } else {
                    console.warn(`Repository ${this.filters.repo} not found in loaded repositories. Available:`, this.repositories.map(r => r.name));
                    // Reset to first available repository or 'projects' as fallback
                    if (this.repositories.length > 0) {
                        this.filters.repo = this.repositories[0].name;
                        this.updateLoadingStatus(`Loading issues for ${this.filters.repo}...`);
                        await this.loadIssuesForRepository(this.filters.repo);
                    }
                }
            } else {
                // Load issues for all repositories
                this.updateLoadingStatus('Loading issues for all repositories...');
                await this.loadIssuesForAllRepositories();
            }

            this.updateUI();
            this.saveToCache();
            this.showLoading(false);

        } catch (error) {
            console.error('Error loading data:', error);

            // Always load repositories from CSV even on API error
            try {
                await this.loadRepositoriesFromCSVToUI();
                this.showFiltersOnError();
            } catch (csvError) {
                this.showError('Failed to load repository data: ' + csvError.message);
            }

            this.showLoading(false);
        }
    }

    async loadRepositoriesFromCSVToUI() {
        // Try to load repositories from GitHub API first if we have a token
        let allRepos = null;
        if (this.githubToken) {
            // Load only ModelEarth repositories that have at least one issue
            allRepos = await this.loadRepositoriesWithIssues();
            this.loadedAllRepositories = false;

            // Get total repository count for UI display
            try {
                this.totalRepositoryCount = await this.getRepositoryCount();
            } catch (error) {
                console.warn('Could not get total repository count:', error);
            }
        } else {
            // Without token, only load projects repo from CSV to avoid rate limiting

            // Initialize rate limit display for anonymous users (60 requests/hour)
            if (this.rateLimitInfo.remaining === null) {
                this.rateLimitInfo.remaining = 60; // GitHub's anonymous rate limit
                this.rateLimitInfo.resetTime = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
                this.updateRateLimitDisplay();
            }
        }

        if (allRepos && allRepos.length > 0) {
            // Use repositories with issues data (already in correct format)
            this.repositories = allRepos;
        } else {
            // Fallback to CSV data - but without token, only show projects repo to conserve rate limits
            const csvRepos = await this.loadRepositoriesFromCSV();

            if (!this.githubToken || this.invalidTokenMessage) {
                // Filter to only show projects repo to avoid exhausting rate limits
                // This includes both no token and invalid token cases
                const projectsRepo = csvRepos.find(repo => repo.repo_name === 'projects');
                if (projectsRepo) {
                    this.repositories = [{
                        name: projectsRepo.repo_name,
                        displayName: projectsRepo.display_name,
                        description: projectsRepo.description,
                        defaultBranch: projectsRepo.default_branch,
                        openIssueCount: null, // Will be loaded on demand
                        totalIssueCount: null,
                        repository_url: `https://github.com/${this.owner}/${projectsRepo.repo_name}`
                    }];

                    // Show cache notification on localhost
                    if (window.location.hostname === 'localhost') {
                        this.showNotification('Repository list loaded from browser cache (localhost)', 'info');
                    }
                } else {
                    console.warn('Projects repo not found in CSV');
                    this.repositories = [];
                }
                this.loadedAllRepositories = false; // Don't load all without valid token
            } else {
                // With valid token but loadRepositoriesWithIssues failed/returned empty
                // This should not happen - fall back to projects repo only for safety
                console.warn('loadRepositoriesWithIssues returned empty - falling back to projects repo only');
                const projectsRepo = csvRepos.find(repo => repo.repo_name === 'projects');
                if (projectsRepo) {
                    this.repositories = [{
                        name: projectsRepo.repo_name,
                        displayName: projectsRepo.display_name,
                        description: projectsRepo.description,
                        defaultBranch: projectsRepo.default_branch,
                        openIssueCount: null, // Will be loaded on demand
                        totalIssueCount: null,
                        repository_url: `https://github.com/${this.owner}/${projectsRepo.repo_name}`
                    }];
                } else {
                    this.repositories = [];
                }
                this.loadedAllRepositories = false;
            }
        }

        // Set projects as default selection if no specific repo is set
        if (this.githubToken && (this.filters.repo === 'modelearth' || this.filters.repo === 'all')) {
            this.filters.repo = 'projects';
        }

        // Start lazy loading: first load projects repo issues, then others in background
        if (this.githubToken) {
            await this.startLazyLoading();
        } else {
            // Only load issue counts for repositories we're actually showing
            // This prevents burning through API requests for repos not in the dropdown
            await this.loadRepositoryIssueCountsForDisplayed();
        }
    }

    async startLazyLoading() {

        // Step 1: Immediately load and display projects repo issues
        const projectsRepo = this.repositories.find(r => r.name === 'projects');
        if (projectsRepo && this.filters.repo === 'projects') {
            try {
                await this.loadIssuesForRepository('projects');
                this.updateRepositoryDropdownCounts();
                this.filterAndDisplayIssues();

                // Show immediate feedback to user
                this.showNotification('Projects issues loaded. Loading other repositories in background...', 'info');
            } catch (error) {
                console.error('Error loading projects repo:', error);
            }
        }

        // Step 2: Start background loading of other repositories
        setTimeout(() => this.lazyLoadOtherRepositories(), 100);
    }

    async lazyLoadOtherRepositories() {

        // Get repositories sorted by priority (projects first, others second)
        const otherRepos = this.repositories
            .filter(r => r.name !== 'projects')
            .sort((a, b) => (a.priority || 2) - (b.priority || 2));

        let loadedCount = 1; // projects already loaded

        for (const repo of otherRepos) {
            try {
                // Add small delay between loads to prevent overwhelming the API
                await new Promise(resolve => setTimeout(resolve, 200));

                await this.loadIssuesForRepository(repo.name);
                loadedCount++;

                // Update UI progressively
                this.updateRepositoryDropdownCounts();

                // Update progress in console

            } catch (error) {
            }
        }

        this.showNotification(`All ${loadedCount} repositories loaded successfully`, 'success');
    }

    async addRepositoryDynamically(repoName) {

        // First check if it exists in the full CSV list
        const csvRepos = await this.loadRepositoriesFromCSV();
        const csvRepo = csvRepos.find(repo => repo.repo_name === repoName);

        if (!csvRepo) {
            throw new Error(`Repository ${repoName} not found in ModelEarth organization`);
        }

        // Check if it has any open issues
        try {
            const openCount = await this.getRepositoryIssueCount(repoName, 'open');

            if (openCount === 0) {
                throw new Error(`Repository ${repoName} has no open issues`);
            }

            // Add to repositories list
            this.repositories.push({
                name: csvRepo.repo_name,
                displayName: csvRepo.display_name,
                description: csvRepo.description,
                defaultBranch: csvRepo.default_branch,
                openIssueCount: openCount,
                totalIssueCount: null, // Will be determined when issues are loaded
                repository_url: `https://github.com/${this.owner}/${csvRepo.repo_name}`,
                priority: 3 // Lower priority for dynamically added repos
            });

            // Update dropdown
            this.populateRepositoryFilter();

            this.showNotification(`Added repository "${repoName}" with ${openCount} open issues`, 'success');

        } catch (error) {
            throw new Error(`Repository ${repoName} not accessible or has no issues`);
        }
    }

    async loadRepositoryIssueCountsForDisplayed() {
        // Only load issue counts for repositories that are actually in our dropdown
        // This prevents burning through API requests for repositories not shown to users
        const reposToLoad = this.repositories.map(repo => repo.name);

        if (reposToLoad.length === 0) {
            return;
        }


        const cacheKey = `repo_issue_counts_${reposToLoad.join('_')}`;
        const cacheTimeKey = `repo_issue_counts_${reposToLoad.join('_')}_time`;

        // Check cache first (valid for 5 minutes)
        const cachedCounts = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedCounts && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

            if (age < fiveMinutes) {
                this.repositoryIssueCounts = JSON.parse(cachedCounts);
                this.lastRefreshTime = new Date(parseInt(cacheTime));
                this.updateRepositoryDropdown();
                this.updateHeaderRefreshDisplay();
                return;
            }
        }

        try {
            this.lastRefreshTime = new Date();
            const counts = {};

            for (const repoName of reposToLoad) {
                try {
                    const openCount = await this.getRepositoryIssueCount(repoName, 'open');
                    const closedCount = await this.getRepositoryIssueCount(repoName, 'closed');

                    counts[repoName] = {
                        open: openCount,
                        closed: closedCount,
                        total: openCount + closedCount
                    };

                } catch (error) {
                    console.warn(`Error loading issue counts for ${repoName}:`, error);
                    // Continue with other repositories
                }
            }

            this.repositoryIssueCounts = counts;

            // Cache the results with repo-specific key
            localStorage.setItem(cacheKey, JSON.stringify(counts));
            localStorage.setItem(cacheTimeKey, Date.now().toString());

            this.updateRepositoryDropdown();
            this.updateHeaderRefreshDisplay();
        } catch (error) {
            console.error('Error loading repository issue counts for displayed repos:', error);
        }
    }

    async loadAllRepositoryIssueCounts() {
        const cacheKey = 'repo_issue_counts';
        const cacheTimeKey = 'repo_issue_counts_time';

        // Check cache first (valid for 5 minutes)
        const cachedCounts = localStorage.getItem(cacheKey);
        const cacheTime = localStorage.getItem(cacheTimeKey);

        if (cachedCounts && cacheTime) {
            const age = Date.now() - parseInt(cacheTime);
            const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

            if (age < fiveMinutes) {
                this.repositoryIssueCounts = JSON.parse(cachedCounts);
                this.lastRefreshTime = new Date(parseInt(cacheTime));
                this.updateRepositoryDropdown();
                this.updateHeaderRefreshDisplay(); // Ensure display is updated
                return;
            }
        }

        // Load fresh issue counts
        try {
            const counts = {};

            for (const repo of this.repositories) {
                try {
                    const openCount = await this.getRepositoryIssueCount(repo.name, 'open');
                    const closedCount = await this.getRepositoryIssueCount(repo.name, 'closed');
                    counts[repo.name] = {
                        open: openCount,
                        closed: closedCount,
                        total: openCount + closedCount
                    };
                } catch (error) {
                    console.error(`Error loading issue count for ${repo.name}:`, error);
                    counts[repo.name] = { open: 0, closed: 0, total: 0 };
                }
            }

            this.repositoryIssueCounts = counts;
            this.lastRefreshTime = new Date();

            // Cache the results
            localStorage.setItem(cacheKey, JSON.stringify(counts));
            localStorage.setItem(cacheTimeKey, Date.now().toString());

            this.updateRepositoryDropdown();
            this.updateHeaderRefreshDisplay(); // Ensure display is updated
        } catch (error) {
            console.error('Error loading repository issue counts:', error);
        }
    }

    async getRepositoryIssueCount(repoName, state = 'open') {
        try {
            // GitHub's repository API open_issues_count includes both issues AND pull requests
            // We need to get actual issues only by fetching and filtering
            const issuesUrl = `${this.baseURL}/repos/${this.owner}/${repoName}/issues?state=${state}&per_page=100`;
            const response = await fetch(issuesUrl, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    ...(this.githubToken && { 'Authorization': `token ${this.githubToken}` })
                }
            });

            // Handle 401 Unauthorized - invalid token
            if (response.status === 401 && this.githubToken) {
                console.warn(`⚠️ Invalid token detected for ${repoName}. Retrying without authentication...`);

                // Show warning message once (not for every repo)
                if (!this.invalidTokenWarningShown) {
                    this.showInvalidTokenMessage('Invalid or expired GitHub token. Switching to unauthenticated access (60 requests/hour).');
                    this.invalidTokenWarningShown = true;
                }

                // Clear the invalid token
                this.githubToken = null;
                localStorage.removeItem('github_token');
                this.clearRateLimit();
                this.updateTokenUI(); // Update UI to reflect cleared token

                // Retry without authentication
                const retryResponse = await fetch(issuesUrl, {
                    headers: {
                        'Accept': 'application/vnd.github.v3+json'
                    }
                });

                // Update rate limit info from retry response
                if (retryResponse.headers.get('X-RateLimit-Remaining')) {
                    this.rateLimitInfo.remaining = parseInt(retryResponse.headers.get('X-RateLimit-Remaining'));
                    this.rateLimitInfo.resetTime = new Date(parseInt(retryResponse.headers.get('X-RateLimit-Reset')) * 1000);
                    this.saveRateLimitToCache();
                    this.updateRateLimitDisplay();
                }

                if (retryResponse.ok) {
                    const issues = await retryResponse.json();
                    const actualIssues = issues.filter(item => !item.pull_request);
                    return actualIssues.length;
                }
                return 0;
            }

            // Handle 403 Forbidden - rate limit exceeded
            if (response.status === 403) {
                const errorData = await response.json().catch(() => ({}));

                // Update rate limit info from response headers
                if (response.headers.get('X-RateLimit-Remaining')) {
                    this.rateLimitInfo.remaining = parseInt(response.headers.get('X-RateLimit-Remaining'));
                    this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                    this.saveRateLimitToCache();
                    this.updateRateLimitDisplay();
                }

                // Show rate limit warning once (not for every repo)
                if (!this.rateLimitWarningShown) {
                    const resetTime = this.rateLimitInfo.resetTime ?
                        new Date(this.rateLimitInfo.resetTime).toLocaleTimeString() : 'soon';

                    this.showError(`Rate limit exceeded. ${errorData.message || 'Please wait until ' + resetTime + ' or add a GitHub token for higher limits.'}`);
                    console.error(`❌ Rate limit exceeded for ${repoName}. Reset time: ${resetTime}`);
                    this.rateLimitWarningShown = true;
                }

                return 0;
            }

            if (response.ok) {
                const issues = await response.json();
                // Filter out pull requests - GitHub issues API returns both issues and PRs
                // Pull requests have a 'pull_request' property, actual issues don't
                const actualIssues = issues.filter(item => !item.pull_request);
                return actualIssues.length;
            }
            return 0;
        } catch (error) {
            console.error(`Error getting issue count for ${repoName}:`, error);
            return 0;
        }
    }

    async loadIssuesForAllRepositories() {

        for (const repo of this.repositories) {
            try {
                this.updateLoadingStatus(`Loading issues for ${repo.name}...`);
                await this.loadIssuesForRepository(repo.name);
            } catch (error) {
                console.error(`Error loading issues for ${repo.name}:`, error);
                // Continue with other repositories
            }
        }

    }

    async loadIssuesForRepository(repoName, forceRefresh = false) {
        // Check memory cache first
        if (!forceRefresh && this.repositoryIssues[repoName]) {
            return this.repositoryIssues[repoName];
        }

        // Check persistent cache for this repository with current state
        if (!forceRefresh) {
            const cachedData = this.loadRepositoryFromCache(repoName, this.filters.projectstatus);
            if (cachedData) {

                // Filter out any invalid issues from cached data
                const validCachedIssues = cachedData.issues.filter(issue => this.isValidIssue(issue));

                this.repositoryIssues[repoName] = validCachedIssues;

                // Update repository object with cached counts
                const repo = this.repositories.find(r => r.name === repoName);
                if (repo && cachedData.metadata) {
                    repo.openIssueCount = cachedData.metadata.openIssueCount;
                    repo.totalIssueCount = cachedData.metadata.totalIssueCount;
                }

                // Set initial last_refreshed timestamp for cached issues that don't have it
                cachedData.issues.forEach(issue => {
                    if (!issue.last_refreshed) {
                        issue.last_refreshed = new Date().toISOString();
                    }
                });

                // Update assignees and labels from cached data
                cachedData.issues.forEach(issue => {
                    if (issue.assignees && issue.assignees.length > 0) {
                        issue.assignees.forEach(assignee => this.assignees.add(assignee.login));
                    }
                    if (issue.labels && issue.labels.length > 0) {
                        issue.labels.forEach(label => this.labels.add(label.name));
                    }
                });

                // Add cached issues to allIssues if they aren't already there
                const existingIds = new Set(this.allIssues.map(issue => issue.id));
                const newCachedIssues = validCachedIssues.filter(issue => !existingIds.has(issue.id));
                this.allIssues.push(...newCachedIssues);

                return cachedData.issues;
            }
        }

        try {
            this.showNotification(`Loading issues for ${repoName}...`, 'info');
            const result = await this.fetchRepositoryIssues(repoName);
            const issues = result.issues;
            const apiResponse = result.apiResponse;

            this.repositoryIssues[repoName] = issues;

            // Update the repository object with issue counts
            const repo = this.repositories.find(r => r.name === repoName);
            if (repo) {
                const openIssues = issues.filter(issue => issue.state === 'open');

                // Special handling for projects repository: 0 issues likely means fetch failed
                if (repoName === 'projects' && issues.length === 0) {
                    console.warn(`⚠️ Projects repository returned 0 issues - likely fetch failed (projects should always have issues)`);
                    // Don't update counts to preserve any existing values or leave as null to indicate unknown state
                    repo.openIssueCount = null;
                    repo.totalIssueCount = null;
                } else {
                    repo.openIssueCount = openIssues.length;
                    repo.totalIssueCount = issues.length;
                }
            }

            // Add to allIssues if not already there
            const existingIssueIds = new Set(this.allIssues.map(issue => issue.id));
            const newIssues = issues.filter(issue => !existingIssueIds.has(issue.id));

            // Set initial last_refreshed timestamp for new issues
            newIssues.forEach(issue => {
                if (!issue.last_refreshed) {
                    issue.last_refreshed = new Date().toISOString();
                }
            });

            this.allIssues.push(...newIssues);

            // Collect assignees and labels
            issues.forEach(issue => {
                if (issue.assignees && issue.assignees.length > 0) {
                    issue.assignees.forEach(assignee => this.assignees.add(assignee.login));
                }
                if (issue.labels && issue.labels.length > 0) {
                    issue.labels.forEach(label => this.labels.add(label.name));
                }
            });

            this.populateAssigneeFilter();
            this.populateLabelFilter();

            // Save repository data to cache with API response metadata
            this.saveRepositoryToCache(repoName, issues, {
                openIssueCount: repo ? repo.openIssueCount : 0,
                totalIssueCount: repo ? repo.totalIssueCount : 0
            }, apiResponse, this.filters.projectstatus);

            return issues;
        } catch (error) {
            console.error(`Failed to load issues for ${repoName}:`, error);
            this.showNotification(`Failed to load issues for ${repoName}`, 'error');
            return [];
        }
    }

    updateRepositoryDropdownCounts() {
        const select = document.getElementById('repoFilter');
        const options = select.querySelectorAll('option');

        options.forEach(option => {
            const repoName = option.value;
            if (repoName !== 'all') {
                const repo = this.repositories.find(r => r.name === repoName);
                const displayName = repo?.displayName || repo?.name || repoName;

                if (repo) {
                    // Try different sources for issue count
                    let issueCount = null;

                    // First try to get from loaded issues
                    if (this.repositoryIssues[repoName]) {
                        const openIssues = this.repositoryIssues[repoName].filter(issue => issue.state === 'open');
                        issueCount = openIssues.length;
                    }
                    // Fall back to repository metadata
                    else if (repo.openIssueCount !== null) {
                        issueCount = repo.openIssueCount;
                    }
                    // Fall back to totalIssueCount for initial load
                    else if (repo.totalIssueCount !== null) {
                        issueCount = repo.totalIssueCount;
                    }

                    if (issueCount !== null) {
                        const issueText = `(${issueCount})`;
                        option.textContent = `${displayName} ${issueText}`;
                    } else {
                        // Only show (?) for projects if we really can't determine count
                        if (repoName === 'projects') {
                            option.textContent = `${displayName} (?)`;
                            option.title = 'Issue count unknown - fetch may have failed';
                        } else {
                            option.textContent = displayName;
                        }
                    }
                } else {
                    option.textContent = displayName;
                }
            }
        });
    }

    async enrichRepositoryData(repo) {
        try {
            // Get repository contents for file count and images
            const contents = await this.apiRequest(`/repos/${this.owner}/${repo.name}/contents`);
            repo.fileCount = contents.filter(item => item.type === 'file').length;

            // Look for images in common directories
            repo.images = [];
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'];

            // Check root directory
            const rootImages = contents.filter(item =>
                item.type === 'file' &&
                imageExtensions.some(ext => item.name.toLowerCase().endsWith(ext))
            );
            repo.images.push(...rootImages.slice(0, 4));

            // Check for common image directories if we need more images
            if (repo.images.length < 4) {
                const imageDirs = ['images', 'img', 'assets', 'static', 'public'];
                for (const dir of imageDirs) {
                    if (repo.images.length >= 4) break;
                    try {
                        const dirContents = await this.apiRequest(`/repos/${this.owner}/${repo.name}/contents/${dir}`);
                        const dirImages = dirContents.filter(item =>
                            item.type === 'file' &&
                            imageExtensions.some(ext => item.name.toLowerCase().endsWith(ext))
                        );
                        repo.images.push(...dirImages.slice(0, 4 - repo.images.length));
                    } catch (e) {
                        // Directory doesn't exist, continue
                    }
                }
            }

            // Get repository statistics
            const stats = await this.apiRequest(`/repos/${this.owner}/${repo.name}/stats/contributors`);
            repo.contributorCount = stats ? stats.length : 1;

        } catch (error) {
            console.warn(`Failed to enrich data for ${repo.name}:`, error);
            repo.fileCount = 0;
            repo.images = [];
            repo.contributorCount = 1;
        }
    }



    isValidIssue(issue) {
        // Check if issue has required fields and is not empty/invalid
        return issue &&
            typeof issue.id === 'number' &&
            typeof issue.number === 'number' &&
            typeof issue.title === 'string' &&
            issue.title.trim().length > 0 &&
            typeof issue.state === 'string' &&
            (issue.state === 'open' || issue.state === 'closed') &&
            issue.created_at &&
            issue.html_url;
    }

    async fetchRepositoryIssues(repoName) {
        const issues = [];
        let page = 1;
        let hasMore = true;
        let lastApiResponse = null; // Track the last successful API response for caching decisions

        // Determine what state to fetch based on current filter
        // Only fetch 'all' if user specifically wants closed or all issues
        const stateToFetch = this.filters.projectstatus === 'all' ? 'all' :
            this.filters.projectstatus === 'closed' ? 'closed' : 'open';


        while (hasMore) {
            try {
                const apiResult = await this.apiRequestWithMetadata(
                    `/repos/${this.owner}/${repoName}/issues?state=${stateToFetch}&per_page=100&page=${page}`
                );

                lastApiResponse = apiResult.metadata;
                const response = apiResult.data;

                if (response.length === 0) {
                    hasMore = false;
                } else {
                    // Filter out pull requests and invalid issues
                    const actualIssues = response.filter(issue => !issue.pull_request && this.isValidIssue(issue));

                    // Enrich each issue with additional data
                    for (const issue of actualIssues) {
                        issue.repository = repoName;
                        issue.repository_url = `https://github.com/${this.owner}/${repoName}`;

                        // Fetch comments if any
                        if (issue.comments > 0) {
                            try {
                                issue.comment_details = await this.apiRequest(
                                    `/repos/${this.owner}/${repoName}/issues/${issue.number}/comments`
                                );
                                console.log(`✅ Loaded ${issue.comment_details.length} comments for issue #${issue.number}`);
                            } catch (e) {
                                console.error(`❌ Failed to load comments for issue #${issue.number} (${issue.title}):`, e.message);
                                // Store error information for debugging
                                issue.comment_details = [];
                                issue.comment_load_error = e.message;
                            }
                        } else {
                            issue.comment_details = [];
                        }
                    }

                    issues.push(...actualIssues);
                    page++;
                }
            } catch (error) {
                console.error(`Error fetching issues for ${repoName}, page ${page}:`, error);

                // Capture error information for caching decisions
                if (error.response) {
                    lastApiResponse = {
                        status: error.response.status,
                        rateLimitRemaining: this.rateLimitInfo.remaining,
                        isError: true,
                        errorMessage: error.message
                    };
                }
                hasMore = false;
            }
        }

        // Return both issues and API response metadata for intelligent caching
        return { issues, apiResponse: lastApiResponse };
    }

    /**
     * Enhanced API request that returns both data and response metadata
     * for intelligent caching decisions
     */
    async apiRequestWithMetadata(endpoint) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
        };
        if (this.githubToken) {
            headers['Authorization'] = `token ${this.githubToken}`;
        }

        const response = await fetch(`${this.baseURL}${endpoint}`, { headers });

        // Extract rate limit information from headers
        let rateLimitRemaining = null;
        if (response.headers.get('X-RateLimit-Remaining')) {
            rateLimitRemaining = parseInt(response.headers.get('X-RateLimit-Remaining'));
            this.rateLimitInfo.remaining = rateLimitRemaining;
            this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
            this.saveRateLimitToCache();
            this.updateRateLimitDisplay();
        }

        const metadata = {
            status: response.status,
            rateLimitRemaining: rateLimitRemaining,
            isError: false
        };

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));

            // Handle invalid token (401 Unauthorized)
            if (response.status === 401) {
                this.showInvalidTokenMessage(errorData.message || 'Invalid or expired GitHub token');

                // Automatically retry without token if we have an invalid token
                if (this.githubToken) {
                    console.warn('⚠️ Invalid token detected. Retrying without authentication...');
                    const tempToken = this.githubToken;
                    this.githubToken = null; // Temporarily clear token for retry
                    localStorage.removeItem('github_token');
                    this.clearRateLimit();
                    this.updateTokenUI(); // Update UI to reflect cleared token

                    try {
                        // Retry the same request without authentication
                        const retryHeaders = {
                            'Accept': 'application/vnd.github.v3+json',
                        };
                        const retryResponse = await fetch(`${this.baseURL}${endpoint}`, { headers: retryHeaders });

                        // Update rate limit info from retry response
                        if (retryResponse.headers.get('X-RateLimit-Remaining')) {
                            this.rateLimitInfo.remaining = parseInt(retryResponse.headers.get('X-RateLimit-Remaining'));
                            this.rateLimitInfo.resetTime = new Date(parseInt(retryResponse.headers.get('X-RateLimit-Reset')) * 1000);
                            this.saveRateLimitToCache();
                            this.updateRateLimitDisplay();
                        }

                        if (retryResponse.ok) {
                            console.log('✅ Successfully loaded data without authentication');
                            this.showNotification('Loaded data without authentication (60 requests/hour limit)', 'info');
                            const retryData = await retryResponse.json();
                            const retryMetadata = {
                                status: retryResponse.status,
                                rateLimitRemaining: this.rateLimitInfo.remaining,
                                isError: false
                            };
                            return { data: retryData, metadata: retryMetadata };
                        } else {
                            this.githubToken = tempToken;
                            const error = new Error(`GitHub API Error: ${retryResponse.status} - ${retryResponse.statusText}`);
                            error.response = metadata;
                            throw error;
                        }
                    } catch (retryError) {
                        this.githubToken = tempToken;
                        throw retryError;
                    }
                }

                const error = new Error(`GitHub API Error: ${response.status} - Invalid token`);
                error.response = metadata;
                throw error;
            }

            // Handle rate limit exceeded
            if (response.status === 403 && errorData.message && errorData.message.includes('rate limit')) {
                this.rateLimitInfo.startTime = new Date();
                this.rateLimitInfo.remaining = 0;
                if (response.headers.get('X-RateLimit-Reset')) {
                    this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                }
                this.saveRateLimitToCache();
                this.updateRateLimitDisplay();
                localStorage.setItem('github_rate_limit_exceeded', 'true');
            }

            const error = new Error(`GitHub API Error: ${response.status} - ${errorData.message || response.statusText}`);
            error.response = metadata;
            throw error;
        }

        const data = await response.json();
        return { data, metadata };
    }

    async apiRequest(endpoint) {
        const headers = {
            'Accept': 'application/vnd.github.v3+json',
        };

        if (this.githubToken) {
            headers['Authorization'] = `token ${this.githubToken}`;
        }

        const response = await fetch(`${this.baseURL}${endpoint}`, { headers });

        // Extract rate limit information from headers
        if (response.headers.get('X-RateLimit-Remaining')) {
            this.rateLimitInfo.remaining = parseInt(response.headers.get('X-RateLimit-Remaining'));
            this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
            this.saveRateLimitToCache();
            this.updateRateLimitDisplay();
        } else if (!this.githubToken) {
            // For anonymous users, assume default rate limit if headers not available
            // This happens when using cached data or when GitHub doesn't return headers
            if (this.rateLimitInfo.remaining === null) {
                this.rateLimitInfo.remaining = 60;
                this.rateLimitInfo.resetTime = new Date(Date.now() + 60 * 60 * 1000);
                this.updateRateLimitDisplay();
            }
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));

            // Handle invalid token (401 Unauthorized)
            if (response.status === 401) {
                this.showInvalidTokenMessage(errorData.message || 'Invalid or expired GitHub token');

                // Automatically retry without token if we have an invalid token
                if (this.githubToken) {
                    console.warn('⚠️ Invalid token detected. Retrying without authentication (60 requests/hour limit)...');
                    const tempToken = this.githubToken;
                    this.githubToken = null; // Temporarily clear token for retry

                    try {
                        // Retry the same request without authentication
                        const retryHeaders = {
                            'Accept': 'application/vnd.github.v3+json',
                        };
                        const retryResponse = await fetch(`${this.baseURL}${endpoint}`, { headers: retryHeaders });

                        // Update rate limit info from retry response
                        if (retryResponse.headers.get('X-RateLimit-Remaining')) {
                            this.rateLimitInfo.remaining = parseInt(retryResponse.headers.get('X-RateLimit-Remaining'));
                            this.rateLimitInfo.resetTime = new Date(parseInt(retryResponse.headers.get('X-RateLimit-Reset')) * 1000);
                            this.saveRateLimitToCache();
                            this.updateRateLimitDisplay();
                        }

                        if (retryResponse.ok) {
                            console.log('✅ Successfully loaded data without authentication');
                            // Keep token cleared since it's invalid
                            this.showNotification('Loaded data without authentication (60 requests/hour limit)', 'info');
                            return await retryResponse.json();
                        } else {
                            // Restore token for user to fix
                            this.githubToken = tempToken;
                            throw new Error(`GitHub API Error: ${retryResponse.status} - ${retryResponse.statusText}`);
                        }
                    } catch (retryError) {
                        // Restore token for user to fix
                        this.githubToken = tempToken;
                        throw retryError;
                    }
                }

                throw new Error(`GitHub API Error: ${response.status} - Invalid token`);
            }

            // Handle rate limit exceeded
            if (response.status === 403 && errorData.message && errorData.message.includes('rate limit')) {
                this.rateLimitInfo.startTime = new Date();
                this.rateLimitInfo.remaining = 0;
                if (response.headers.get('X-RateLimit-Reset')) {
                    this.rateLimitInfo.resetTime = new Date(parseInt(response.headers.get('X-RateLimit-Reset')) * 1000);
                }
                this.saveRateLimitToCache();
                this.updateRateLimitDisplay();

                // Flag that rate limit was exceeded for later token refresh detection
                localStorage.setItem('github_rate_limit_exceeded', 'true');
            }

            throw new Error(`GitHub API Error: ${response.status} - ${errorData.message || response.statusText}`);
        }

        return await response.json();
    }

    updateProgress(current, total, type) {
        const percentage = Math.round((current / total) * 100);
        const progressBar = document.getElementById('progressBar');
        const loadingStatus = document.getElementById('loadingStatus');

        if (progressBar) {
            progressBar.style.width = `${percentage}%`;
        }

        if (loadingStatus) {
            loadingStatus.textContent = `Processing ${current}/${total} ${type}...`;
        }
    }

    updateUI() {
        this.populateRepositoryFilter();
        this.populateAssigneeFilter();
        this.populateLabelFilter();
        this.updateStats();
        this.updateRateLimitDisplay();
        this.updateCacheStatusDisplay();
        this.filterAndDisplayIssues();

        // Update filter UI after repositories are loaded to ensure dropdown selections work
        this.updateFilterUI();

        // Clear rate limit exceeded flag if we successfully loaded data
        if (this.allIssues.length > 0 || this.repositories.length > 0) {
            localStorage.removeItem('github_rate_limit_exceeded');
        }

        // Keep filters hidden by default - user can toggle with search button
        // document.getElementById('filtersSection').style.display = 'block';
        document.getElementById('statsSection').style.display = 'flex';
        document.getElementById('issuesContainer').style.display = 'block';
    }

    populateRepositoryFilter() {
        const select = document.getElementById('repoFilter');

        // Calculate total for "All Repositories"
        let totalIssues = 0;
        if (this.repositoryIssueCounts) {
            totalIssues = Object.values(this.repositoryIssueCounts)
                .reduce((sum, counts) => sum + (counts.total || 0), 0);
        }

        const allReposText = totalIssues > 0 ? `All Loaded Issues (${totalIssues})` : 'All Loaded Issues';

        // Start with empty select
        select.innerHTML = '';

        // Sort repositories to put Projects first, then others, then All Repositories at the end
        const sortedRepos = [...this.repositories].sort((a, b) => {
            if (a.name === 'projects') return -1;
            if (b.name === 'projects') return 1;
            const aName = (a.displayName || a.name || '').toString();
            const bName = (b.displayName || b.name || '').toString();
            return aName.localeCompare(bName);
        });

        // Add individual repositories first (Projects will be at the top)
        sortedRepos.forEach(repo => {
            const option = document.createElement('option');
            option.value = repo.name;

            // Use cached issue counts if available
            const counts = this.repositoryIssueCounts[repo.name];
            let issueText = '';

            if (counts && counts.total > 0) {
                issueText = ` (${counts.total})`;
            } else if (repo.openIssueCount !== null) {
                issueText = ` (${repo.openIssueCount})`;
            } else if (repo.name === 'projects') {
                // Special indicator for projects repo when fetch failed
                issueText = ' (?)';
                option.title = 'Issue count unknown - fetch may have failed';
            }

            const repoName = repo.displayName || repo.name || 'Unknown';
            option.textContent = `${repoName}${issueText}`;
            select.appendChild(option);
        });

        // Add loading options based on repository and token status
        if (!this.loadedAllRepositories) {
            // Add separator
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '─────────────────';
            select.appendChild(separator);

            if (this.githubToken) {
                // Add currently loaded repos indicator
                const loadPrimaryOption = document.createElement('option');
                loadPrimaryOption.value = 'load_primary';
                const primaryCount = this.repositories.length;
                loadPrimaryOption.textContent = `Currently Loaded: ${primaryCount} Repos`;
                loadPrimaryOption.disabled = true; // Already loaded
                loadPrimaryOption.style.color = '#666';
                select.appendChild(loadPrimaryOption);

                // Add load all repos option
                const loadAllOption = document.createElement('option');
                loadAllOption.value = 'load_all';
                if (this.totalRepositoryCount !== null) {
                    loadAllOption.textContent = `Load All ${this.totalRepositoryCount} Repos`;
                } else {
                    loadAllOption.textContent = 'Load All Repos';
                }
                loadAllOption.style.fontStyle = 'italic';
                select.appendChild(loadAllOption);
            } else {
                // Without token, show option to load all but with warning
                const tokenHint = document.createElement('option');
                tokenHint.disabled = true;
                tokenHint.textContent = '⚠️ Add GitHub Token for full repo access';
                tokenHint.style.fontSize = '0.85em';
                tokenHint.style.color = '#dc3545';
                select.appendChild(tokenHint);
            }
        }

        // Add "All Repositories" option at the end
        const allOption = document.createElement('option');
        allOption.value = 'all';
        allOption.textContent = allReposText;
        select.appendChild(allOption);

        select.value = this.filters.repo;

        // If projects repo exists in the list, make sure it's selected when appropriate
        const projectsOption = Array.from(select.options).find(option => option.value === 'projects');
        if (projectsOption && this.filters.repo === 'projects') {
            select.value = 'projects';
        }
    }

    updateRepositoryDropdown() {
        // Update the dropdown with current issue counts
        this.populateRepositoryFilter();

        // Update the last refresh time display
        this.updateLastRefreshDisplay();
    }

    populateRepositoryDropdown() {
        // Alias for backwards compatibility
        this.updateRepositoryDropdown();
    }

    updateLastRefreshDisplay() {
        // This method is kept for backwards compatibility
        this.updateHeaderRefreshDisplay();
    }

    updateHeaderRefreshDisplay() {
        // Send refresh time to console instead of displaying on page
        if (this.lastRefreshTime) {
            const timeString = this.lastRefreshTime.toLocaleTimeString([], {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } else {
        }

        // Keep the header refresh time display hidden
        const headerLastRefreshTime = document.getElementById('headerLastRefreshTime');
        if (headerLastRefreshTime) {
            headerLastRefreshTime.style.display = 'none';
        }
    }

    startAutoRefreshTimer() {
        // Don't start auto-refresh without a token to conserve rate limits
        if (!this.githubToken) {
            return;
        }

        // Clear existing timer
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }

        // Check every 5 minutes if we can refresh
        this.autoRefreshInterval = setInterval(async () => {
            const cacheTime = localStorage.getItem('repo_issue_counts_time');
            if (cacheTime) {
                const age = Date.now() - parseInt(cacheTime);
                const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds

                if (age >= fiveMinutes) {
                    await this.loadAllRepositoryIssueCounts();
                }
            }
        }, 5 * 60 * 1000); // Check every 5 minutes
    }

    stopAutoRefreshTimer() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
    }

    populateAssigneeFilter() {
        const dropdown = document.getElementById('assigneeDropdown');

        // Keep existing default options
        const defaultOptions = dropdown.innerHTML;
        dropdown.innerHTML = defaultOptions;

        // Add assignees
        Array.from(this.assignees).sort().forEach(assignee => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.setAttribute('data-assignee', assignee);
            item.innerHTML = `<i class="fas fa-user"></i> ${assignee.split('-')[0]}`;
            dropdown.appendChild(item);
        });

        // Set default assignee based on gitAccount if available
        setTimeout(() => {
            if (typeof updateAssigneeButtonDefault === 'function') {
                updateAssigneeButtonDefault();
            }
        }, 100);
    }

    populateLabelFilter() {
        const dropdown = document.getElementById('labelDropdown');

        // Keep existing default options
        const defaultOptions = dropdown.innerHTML;
        dropdown.innerHTML = defaultOptions;

        // Add labels
        Array.from(this.labels).sort().forEach(label => {
            const item = document.createElement('div');
            item.className = 'dropdown-item';
            item.setAttribute('data-label', label);
            item.innerHTML = `<i class="fas fa-tag"></i> ${label}`;
            dropdown.appendChild(item);
        });
    }

    updateStats() {
        const totalRepos = this.repositories.length;
        const openIssues = this.allIssues.filter(issue => issue.state === 'open').length;
        const closedIssues = this.allIssues.filter(issue => issue.state === 'closed').length;
        const totalComments = this.allIssues.reduce((sum, issue) => sum + (issue.comments || 0), 0);

        document.getElementById('repoCount').textContent = totalRepos;
        document.getElementById('openIssueCount').textContent = openIssues;
        document.getElementById('closedIssueCount').textContent = closedIssues;
        document.getElementById('totalComments').textContent = totalComments;
    }

    filterAndDisplayIssues() {

        let repositoryFilteredOut = 0;
        let statusFilteredOut = 0;
        let assigneeFilteredOut = 0;
        let labelFilteredOut = 0;
        let searchFilteredOut = 0;

        this.filteredIssues = this.allIssues.filter(issue => {
            // Repository filter
            if (this.filters.repo !== 'all' && issue.repository !== this.filters.repo) {
                repositoryFilteredOut++;
                return false;
            }

            // Project status filter
            if (this.filters.projectstatus !== 'all' && issue.state !== this.filters.projectstatus) {
                statusFilteredOut++;
                return false;
            }

            // Assignee filter
            if (this.filters.assignee !== 'all') {
                if (this.filters.assignee === 'unassigned') {
                    if (issue.assignees && issue.assignees.length > 0) return false;
                } else {
                    if (!issue.assignees || !issue.assignees.some(a => a.login === this.filters.assignee)) {
                        return false;
                    }
                }
            }

            // Label filter
            if (this.filters.label !== 'all') {
                if (!issue.labels || !issue.labels.some(l => l.name === this.filters.label)) {
                    return false;
                }
            }

            // Search filter
            if (this.filters.search) {
                const searchTerm = this.filters.search.toLowerCase();
                const searchableText = [
                    issue.title,
                    issue.body || '',
                    issue.number.toString(),
                    ...(issue.labels || []).map(l => l.name)
                ].join(' ').toLowerCase();

                if (!searchableText.includes(searchTerm)) {
                    return false;
                }
            }

            return true;
        });


        // Debug output

        if (this.filteredIssues.length === 0 && this.allIssues.length > 0) {
            console.warn('⚠️ All issues were filtered out! Check your filter settings.');
        }

        this.sortIssues();
        this.displayIssues();
        this.updateSearchStatus();

    }

    sortIssues() {
        this.filteredIssues.sort((a, b) => {
            switch (this.filters.sort) {
                case 'created':
                    return new Date(b.created_at) - new Date(a.created_at);
                case 'comments':
                    return (b.comments || 0) - (a.comments || 0);
                case 'title':
                    return (a.title || '').localeCompare(b.title || '');
                case 'number':
                    return a.number - b.number;
                case 'updated':
                default:
                    return new Date(b.updated_at) - new Date(a.updated_at);
            }
        });
    }

    displayIssues() {
        const issuesList = document.getElementById('issuesList');
        const startIndex = (this.currentPage - 1) * this.perPage;
        const endIndex = startIndex + this.perPage;
        const pageIssues = this.filteredIssues.slice(startIndex, endIndex);

        issuesList.innerHTML = '';

        if (pageIssues.length === 0) {
            // Show token prompt if no token available, otherwise show regular no issues message
            if (!this.githubToken || this.invalidTokenMessage) {
                issuesList.innerHTML = `
                    <div class="no-issues">
                        <i class="fas fa-search"></i>
                        <h3>Add your token</h3>
                        <p>Access more repositories and increase API rate limits</p>
                        <button class="btn btn-primary" onclick="issuesManager.showTokenSectionAndOpenTab()" style="margin-top: 10px;">
                            Get Your Token
                        </button>
                    </div>
                `;
            } else {
                issuesList.innerHTML = `
                    <div class="no-issues">
                        <i class="fas fa-search"></i>
                        <h3>No issues found</h3>
                        <p>Try adjusting your filters or search terms.</p>
                    </div>
                `;
            }
        } else {
            pageIssues.forEach(issue => {
                const issueElement = this.createIssueElement(issue);
                issuesList.appendChild(issueElement);
            });
        }

        this.updatePagination();

        // Update Clear All Filters button visibility whenever filters are applied
        this.updateClearAllFiltersVisibility();
    }

    createIssueElement(issue) {
        const issueDiv = document.createElement('div');
        issueDiv.className = 'issue-item';
        issueDiv.setAttribute('data-issue-id', issue.id);

        // Determine if we're showing multiple repositories
        const showingMultipleRepos = this.filters.repo === 'all' || this.repositoryIssueCounts && Object.keys(this.repositoryIssueCounts).length > 1;

        // Get current view type
        const currentView = this.currentView;

        const stateIcon = ''; // Remove state icons

        const assigneesHtml = issue.assignees && issue.assignees.length > 0 ?
            issue.assignees.map(assignee => `
                <img src="${assignee.avatar_url}" alt="${assignee.login}" class="assignee-avatar" title="${assignee.login}"> 
                 <span >${assignee.login.split('-')[0].toLowerCase()}</span>
            `).join('') : '';

        const labelsHtml = issue.labels && issue.labels.length > 0 ?
            issue.labels.map(label => `
                <span class="issue-label" style="background-color: #${label.color}; color: ${this.getContrastColor(label.color)}">
                    ${label.name}
                </span>
            `).join('') : '';

        // Short view content (title + body preview)
        if (currentView === 'short') {
            // Process body: limit to 180 chars and remove line returns
            const processedBody = issue.body ?
                issue.body.replace(/\r?\n/g, ' ').substring(0, 180) : '';
            const hasMore = issue.body && issue.body.length > 180;

            // Prepare detailed content for expansion
            const assigneesDetailHtml = issue.assignees && issue.assignees.length > 0 ?
                issue.assignees.map(assignee => `
                    <div class="assignee-detail">
                        <img src="${assignee.avatar_url}" alt="${assignee.login}" class="assignee-avatar">
                        <span>${assignee.login.split('-')[0].toLowerCase()}</span>
                    </div>
                `).join('') : '<span class="text-muted">No assignees</span>';

            const labelsDetailHtml = issue.labels && issue.labels.length > 0 ?
                issue.labels.map(label => `
                    <span class="issue-label" style="background-color: #${label.color}; color: ${this.getContrastColor(label.color)}">
                        ${label.name}
                    </span>
                `).join('') : '<span class="text-muted">No labels</span>';

            const commentsHtml = issue.comment_details && issue.comment_details.length > 0 ?
                issue.comment_details.map(comment => `
                    <div class="comment-item">
                        <div class="comment-header">
                            <img src="${comment.user.avatar_url}" alt="${comment.user.login}" class="comment-avatar">
                            <strong>${comment.user.login}</strong>
                            <span class="comment-date">${this.formatDate(comment.created_at)}</span>
                        </div>
                        <div class="comment-body">
                            ${this.formatMarkdown(comment.body)}
                        </div>
                    </div>
                `).join('') :
                issue.comment_load_error ?
                    `<p class="text-muted"><i class="fas fa-exclamation-triangle"></i> Failed to load comments: ${issue.comment_load_error}. <a href="${issue.html_url}#issuecomment-section" target="_blank">View comments on GitHub</a></p>` :
                    '<p class="text-muted">No comments</p>';

            issueDiv.innerHTML = `
                <div class="issue-header">
                    <!-- Repo name and issue number line -->
                    <div class="issue-repo-line">
                        <a href="${issue.html_url}" target="_blank" class="repo-issue-link" title="Open in GitHub">
                            ${issue.repository.charAt(0).toUpperCase() + issue.repository.slice(1)} #${issue.number}
                        </a>

                        <!-- Issue Actions Menu -->
                        <div class="issue-actions-menu shifted-menu">
                            <button class="issue-menu-btn" onclick="issuesManager.toggleIssueMenu('${issue.id}', event)" title="Issue Actions">
                                <i class="fas fa-ellipsis-v"></i>
                            </button>
                            <div class="issue-menu-dropdown" id="issueMenu-${issue.id}">
                                <div class="menu-item" onclick="issuesManager.refreshSingleIssue('${issue.id}')">
                                    <i class="fas fa-sync-alt"></i> Refresh
                                </div>
                                <div class="menu-item" onclick="window.open('${issue.html_url}', '_blank')">
                                    <i class="fas fa-external-link-alt"></i> Open in GitHub
                                </div>
                                <div class="menu-item" onclick="issuesManager.copyIssueLink('${issue.html_url}')">
                                    <i class="fas fa-link"></i> Copy Link
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Title -->
                    <h4 class="issue-title short-title">
                        #${issue.number} ${this.escapeHtml(issue.title)}
                    </h4>
                </div>
                ${processedBody ? `
                    <div class="issue-description short-description" onclick="issuesManager.expandIssueDetails('${issue.id}', event)" style="cursor: pointer;" title="Click to expand details">
                        ${this.escapeHtml(processedBody)}${hasMore ? '... ' : ''}${hasMore ? `<a href="#" class="more-link" onclick="issuesManager.expandIssueDetails('${issue.id}', event); return false;" title="Show full description">more</a>` : ''}
                    </div>
                ` : ''}

                <!-- Hidden full details -->
                <div class="issue-full-details" id="fullDetails-${issue.id}" style="display: none;">
                    <div class="issue-detail-inline">
                        <!-- Metadata Section -->
                        <div class="issue-meta-inline">
                            <span class="issue-date">
                                <i class="fas fa-plus"></i> Created: ${this.formatDate(issue.created_at)}
                            </span>
                            <span class="issue-date">
                                <i class="fas fa-clock"></i> Updated: ${this.formatDate(issue.updated_at)}
                            </span>
                            <span class="issue-date">
                                <i class="fas fa-sync-alt"></i> Last Refreshed:
                                <a href="#" onclick="issuesManager.showRefreshDialog('${issue.id}'); return false;" class="refresh-link" title="Click to refresh this issue">
                                    ${issue.last_refreshed ? this.formatFullDateTime(issue.last_refreshed) : this.formatFullDateTime(issue.created_at)}
                                </a>
                            </span>
                            ${issue.comments > 0 ? `
                                <span class="comment-count">
                                    <i class="fas fa-comments"></i> ${issue.comments} comment${issue.comments > 1 ? 's' : ''}
                                </span>
                            ` : ''}
                        </div>

                        <!-- Description Section -->
                        ${issue.body ? `
                            <div class="issue-section-inline">
                                <h5 class="section-title">Description</h5>
                                <div class="issue-description-full">
                                    ${this.formatMarkdown(issue.body)}
                                </div>
                            </div>
                        ` : ''}

                        <!-- Labels Section -->
                        ${labelsDetailHtml ? `
                            <div class="issue-section-inline">
                                <h5 class="section-title">Labels</h5>
                                <div class="issue-labels-detail">
                                    ${labelsDetailHtml}
                                </div>
                            </div>
                        ` : ''}

                        <!-- Assignees Section -->
                        <div class="issue-section-inline">
                            <h5 class="section-title">Assignees</h5>
                            <div class="assignees-detail">
                                ${assigneesDetailHtml}
                            </div>
                        </div>

                        <!-- Comments Section -->
                        ${issue.comments > 0 ? `
                            <div class="issue-section-inline">
                                <h5 class="section-title">Comments (${issue.comments})</h5>
                                <div class="comments-section-inline">
                                    ${commentsHtml}
                                </div>
                            </div>
                        ` : ''}

                        <!-- Action Buttons -->
                        <div class="issue-actions-inline">
                            <a href="${issue.html_url}" target="_blank" class="btn btn-primary btn-sm">
                                <i class="fab fa-github"></i> View on GitHub
                            </a>
                            <a href="${issue.html_url}/edit" target="_blank" class="btn btn-secondary btn-sm">
                                <i class="fas fa-edit"></i> Edit Issue
                            </a>
                        </div>

                        <!-- Collapse Link -->
                        <div class="collapse-link-container">
                            <a href="#" class="less-link" onclick="issuesManager.collapseIssueDetails('${issue.id}', event); return false;" title="Show less">
                                <i class="fas fa-chevron-up"></i> less
                            </a>
                        </div>
                    </div>
                </div>
            `;
            return issueDiv;
        }

        // List view and other views
        const repoInfo = this.repositories.find(r => r.name === issue.repository) || {};
        const repoImages = repoInfo.images && repoInfo.images.length > 0 ? `
            <div class="repo-images">
                ${repoInfo.images.slice(0, 2).map(img => `
                    <img src="${img.download_url}" alt="${img.name}" class="repo-image">
                `).join('')}
            </div>
        ` : '';

        issueDiv.innerHTML = `
            <div class="issue-header">
                <div class="issue-title-row">
                    <h4 class="issue-title">
                        <a href="${issue.html_url}" target="_blank">#${issue.number} ${this.escapeHtml(issue.title)}</a>
                    </h4>
                    
                    <!-- Issue Actions Menu -->
                    <div class="issue-actions-menu">
                        <button class="issue-menu-btn" onclick="issuesManager.toggleIssueMenu('${issue.id}', event)" title="Issue Actions">
                            <i class="fas fa-ellipsis-v"></i>
                        </button>
                        <div class="issue-menu-dropdown" id="issueMenu-${issue.id}">
                            <div class="menu-item" onclick="issuesManager.refreshSingleIssue('${issue.id}')">
                                <i class="fas fa-sync-alt"></i> Refresh
                            </div>
                            <div class="menu-item" onclick="window.open('${issue.html_url}', '_blank')">
                                <i class="fas fa-external-link-alt"></i> Open in GitHub
                            </div>
                            <div class="menu-item" onclick="issuesManager.copyIssueLink('${issue.html_url}')">
                                <i class="fas fa-link"></i> Copy Link
                            </div>
                        </div>
                    </div>
                </div>
                <div class="issue-meta">
                    <span class="repo-name">
                        <i class="fas fa-code-branch"></i>
                        <a href="${issue.repository_url}" target="_blank">${issue.repository}</a>
                    </span>
                    <span class="issue-date">
                        <i class="fas fa-clock"></i>
                        Updated ${this.formatDate(issue.updated_at)}
                    </span>
                    ${issue.comments > 0 ? `
                        <span class="comment-count">
                            <i class="fas fa-comments"></i>
                            ${issue.comments}
                        </span>
                    ` : ''}
                </div>
            </div>

            <div class="issue-body">
                ${issue.body ? `
                    <div class="issue-description">
                        ${this.formatMarkdown(issue.body.substring(0, 300))}
                        ${issue.body.length > 300 ? '...' : ''}
                    </div>
                ` : ''}
                
                ${labelsHtml ? `<div class="issue-labels">${labelsHtml}</div>` : ''}
                
                <div class="issue-footer">
                    <div class="issue-author">
                        <img src="${issue.user.avatar_url}" alt="${issue.user.login}" class="author-avatar">
                        <span>by ${issue.user.login.split("-")[0]}</span>          
                    </div>
                    
                    ${assigneesHtml ? `<div class="issue-assignees"> <span> Assigned To : </span> ${assigneesHtml}</div>` : ''}
                    
                    <div class="issue-actions">
                        <button class="btn btn-sm btn-outline" onclick="issuesManager.showIssueDetails(${issue.id})">
                            <i class="fas fa-eye"></i><span> Details</span>
                        </button>
                        <!-- GitHub button commented out - now available in 3-dot menu -->
                        <!--<a href="${issue.html_url}" target="_blank" class="btn btn-sm btn-outline">
                            <i class="fab fa-github"></i><span> GitHub</span>
                        </a>-->
                    </div>
                </div>
                
                ${repoImages}
                
                <!-- Content for narrow card view (handled by CSS) -->
                
                ${!showingMultipleRepos && issue.body ? `
                    <div class="issue-body-preview">
                        ${this.formatMarkdown(issue.body.substring(0, 100))}${issue.body.length > 100 ? '...' : ''}
                    </div>
                ` : ''}
            </div>
        `;

        return issueDiv;
    }

    async showIssueDetails(issueId) {
        const issue = this.allIssues.find(i => i.id == issueId);
        if (!issue) return;

        const modal = document.getElementById('issueModal');
        const modalTitle = document.getElementById('modalTitle');
        const modalBody = document.getElementById('modalBody');

        modalTitle.textContent = `${issue.title} #${issue.number}`;

        // Create detailed view
        const stateIcon = ''; // Remove state icons

        const assigneesHtml = issue.assignees && issue.assignees.length > 0 ?
            issue.assignees.map(assignee => `
                <div class="assignee-detail">
                    <img src="${assignee.avatar_url}" alt="${assignee.login}" class="assignee-avatar">
                    <span >${assignee.login.split('-')[0].toLowerCase()}</span>
                </div>
            `).join('') : '<span class="text-muted">No assignees</span>';

        const labelsHtml = issue.labels && issue.labels.length > 0 ?
            issue.labels.map(label => `
                <span class="issue-label" style="background-color: #${label.color}; color: ${this.getContrastColor(label.color)}">
                    ${label.name}
                </span>
            `).join('') : '<span class="text-muted">No labels</span>';

        const commentsHtml = issue.comment_details && issue.comment_details.length > 0 ?
            issue.comment_details.map(comment => `
                <div class="comment-item">
                    <div class="comment-header">
                        <img src="${comment.user.avatar_url}" alt="${comment.user.login}" class="comment-avatar">
                        <strong>${comment.user.login}</strong>
                        <span class="comment-date">${this.formatDate(comment.created_at)}</span>
                    </div>
                    <div class="comment-body">
                        ${this.formatMarkdown(comment.body)}
                    </div>
                </div>
            `).join('') :
            issue.comment_load_error ?
                `<p class="text-muted"><i class="fas fa-exclamation-triangle"></i> Failed to load comments: ${issue.comment_load_error}. <a href="${issue.html_url}#issuecomment-section" target="_blank">View comments on GitHub</a></p>` :
                '<p class="text-muted">No comments</p>';

        modalBody.innerHTML = `
            <div class="issue-detail">
                <div class="issue-header-detail">
                    ${stateIcon}
                    <div class="issue-meta-detail">
                        <div class="repo-info">
                            <i class="fas fa-code-branch"></i>
                            <a href="${issue.repository_url}" target="_blank">${issue.repository}</a>
                        </div>
                        <div class="issue-dates">
                            <div><i class="fas fa-plus"></i> Created: ${this.formatDate(issue.created_at)}</div>
                            <div><i class="fas fa-clock"></i> Updated: ${this.formatDate(issue.updated_at)}</div>
                            <div><i class="fas fa-sync-alt"></i> Last Refreshed: 
                                <a href="#" onclick="issuesManager.showRefreshDialog('${issue.id}'); return false;" class="refresh-link" title="Click to refresh this issue">
                                    ${issue.last_refreshed ? this.formatFullDateTime(issue.last_refreshed) : this.formatFullDateTime(issue.created_at)}
                                </a>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="issue-section">
                    <h4>Description</h4>
                    <div class="issue-description-full">
                        ${issue.body ? this.formatMarkdown(issue.body) : '<span class="text-muted">No description provided</span>'}
                    </div>
                </div>

                <div class="issue-section">
                    <h4>Labels</h4>
                    <div class="issue-labels-detail">
                        ${labelsHtml}
                    </div>
                </div>

                <div class="issue-section">
                    <h4>Assignees</h4>
                    <div class="assignees-detail">
                        ${assigneesHtml}
                    </div>
                </div>

                <div class="issue-section">
                    <h4>Comments (${issue.comments || 0})</h4>
                    <div class="comments-section">
                        ${commentsHtml}
                    </div>
                </div>

                <div class="issue-actions-detail">
                    <a href="${issue.html_url}" target="_blank" class="btn btn-primary">
                        <i class="fab fa-github"></i> View on GitHub
                    </a>
                    <a href="${issue.html_url}/edit" target="_blank" class="btn btn-secondary">
                        <i class="fas fa-edit"></i> Edit Issue
                    </a>
                </div>
            </div>
        `;

        modal.style.display = 'flex';
    }

    closeModal() {
        document.getElementById('issueModal').style.display = 'none';
    }

    showRefreshDialog(issueId) {
        this.currentRefreshIssueId = issueId;
        const issue = this.allIssues.find(i => i.id == issueId);
        if (!issue) return;

        document.getElementById('refreshDialogTitle').textContent = `Refresh Issue #${issue.number}`;
        document.getElementById('refreshDialog').style.display = 'flex';
    }

    closeRefreshDialog() {
        document.getElementById('refreshDialog').style.display = 'none';
        this.currentRefreshIssueId = null;
    }

    async confirmRefreshDialog() {
        if (this.currentRefreshIssueId) {
            // Store the ID before closing dialog (which sets it to null)
            const issueIdToRefresh = this.currentRefreshIssueId;

            // Close the refresh dialog
            this.closeRefreshDialog();

            // Refresh the issue
            await this.refreshSingleIssue(issueIdToRefresh);

            // Update the modal if it's still open
            const modal = document.getElementById('issueModal');
            if (modal.style.display !== 'none') {
                const issue = this.allIssues.find(i => i.id == issueIdToRefresh);
                if (issue) {
                    // Re-render the modal with updated data
                    this.showIssueDetails(issueIdToRefresh);
                }
            }
        }
    }

    updatePagination() {
        const totalPages = Math.ceil(this.filteredIssues.length / this.perPage);
        const startIndex = (this.currentPage - 1) * this.perPage;
        const endIndex = Math.min(startIndex + this.perPage, this.filteredIssues.length);

        // Get container width for display
        const container = document.getElementById(this.containerId);
        const containerWidth = container ? container.offsetWidth : 0;

        // Update pagination info with width and fullscreen controls
        const paginationInfo = document.getElementById('paginationInfo');
        const fullscreenIcon = this.isFullscreen ? 'fa-compress' : 'fa-expand';
        const fullscreenTitle = this.isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen';

        const leftText = this.filteredIssues.length === 0 ?
            'No issues found' :
            `Showing ${startIndex + 1}-${endIndex} of ${this.filteredIssues.length} issues (${this.perPage} per page)`;

        const rightText = `Widget width ${containerWidth}px <i class="fas ${fullscreenIcon} fullscreen-btn" onclick="issuesManager.toggleFullscreen()" title="${fullscreenTitle}" style="margin-left: 0.5rem; cursor: pointer; color: var(--primary-color);"></i>`;

        paginationInfo.innerHTML = `<span class="pagination-left">${leftText}</span><span class="pagination-right" style="color: var(--text-muted); font-size: 0.85em;">${rightText}</span>`;

        // Update header fullscreen icon
        const headerIcon = document.querySelector('.header-fullscreen-btn');
        if (headerIcon) {
            headerIcon.className = `fas ${fullscreenIcon} header-fullscreen-btn`;
            headerIcon.title = fullscreenTitle;
        }

        // Update pagination controls
        const paginationControls = document.getElementById('paginationControls');
        paginationControls.innerHTML = '';

        if (totalPages <= 1) return;

        // Previous button
        const prevButton = document.createElement('button');
        prevButton.className = `pagination-btn ${this.currentPage === 1 ? 'disabled' : ''}`;
        prevButton.innerHTML = '<i class="fas fa-chevron-left"></i>';
        prevButton.onclick = () => this.goToPage(this.currentPage - 1);
        paginationControls.appendChild(prevButton);

        // Page numbers
        const maxVisiblePages = 5;
        let startPage = Math.max(1, this.currentPage - Math.floor(maxVisiblePages / 2));
        let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

        if (endPage - startPage + 1 < maxVisiblePages) {
            startPage = Math.max(1, endPage - maxVisiblePages + 1);
        }

        for (let i = startPage; i <= endPage; i++) {
            const pageButton = document.createElement('button');
            pageButton.className = `pagination-btn ${i === this.currentPage ? 'active' : ''}`;
            pageButton.textContent = i;
            pageButton.onclick = () => this.goToPage(i);
            paginationControls.appendChild(pageButton);
        }

        // Next button
        const nextButton = document.createElement('button');
        nextButton.className = `pagination-btn ${this.currentPage === totalPages ? 'disabled' : ''}`;
        nextButton.innerHTML = '<i class="fas fa-chevron-right"></i>';
        nextButton.onclick = () => this.goToPage(this.currentPage + 1);
        paginationControls.appendChild(nextButton);
    }

    goToPage(page) {
        const totalPages = Math.ceil(this.filteredIssues.length / this.perPage);
        if (page < 1 || page > totalPages) return;

        this.currentPage = page;
        this.displayIssues();

        // Scroll to top of issues
        document.getElementById('issuesContainer').scrollIntoView({ behavior: 'smooth' });
    }

    // Utility methods
    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return 'today';
        if (diffDays === 1) return 'yesterday';
        if (diffDays < 7) return `${diffDays} days ago`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
        if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;

        return date.toLocaleDateString();
    }

    formatFullDateTime(dateString) {
        const date = new Date(dateString);
        return date.toLocaleString();
    }

    formatMarkdown(text) {
        // Basic markdown formatting
        return text
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')
            .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank">$1</a>');
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    getContrastColor(hexColor) {
        // Convert hex to RGB
        const r = parseInt(hexColor.substr(0, 2), 16);
        const g = parseInt(hexColor.substr(2, 2), 16);
        const b = parseInt(hexColor.substr(4, 2), 16);

        // Calculate luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    // State management
    updateHash() {
        const params = new URLSearchParams();
        Object.entries(this.filters).forEach(([key, value]) => {
            if (value && value !== 'all' && value !== '') {
                params.set(key, value);
            }
        });

        const hash = params.toString() ? `#${params.toString()}` : '';
        window.history.replaceState(null, null, window.location.pathname + hash);
    }

    async loadFromHash() {
        const hash = window.location.hash.substring(1);
        if (!hash) return;

        const params = new URLSearchParams(hash);
        let customRepo = null;

        params.forEach((value, key) => {
            if (key === 'repo') {
                // Handle custom repository from URL hash
                customRepo = value;
                // Extract just the repo name for dropdown compatibility
                // For "modelearth/realitystream" → "realitystream"
                // For "realitystream" → "realitystream"  
                const repoName = value.includes('/') ? value.split('/')[1] : value;
                this.filters[key] = repoName;
            } else if (this.filters.hasOwnProperty(key)) {
                this.filters[key] = value;
            }
        });

        // If we have a custom repo from the hash, add it to the repository list
        if (customRepo && customRepo !== 'all') {
            // Extract just the repo name for consistency
            const repoName = customRepo.includes('/') ? customRepo.split('/')[1] : customRepo;
            try {
                await this.addCustomRepositoryFromHash(repoName);
            } catch (error) {
                this.showNotification(`Repository "${repoName}" not found on ModelEarth GitHub. Please check the repository name.`, 'error');
                // Reset to 'all' filter to show available repositories
                this.filters.repo = 'all';
                this.updateFilterUI();
                return;
            }

            // Load issues for the selected repository if not already cached
            if (!this.repositoryIssues[this.filters.repo]) {
                try {
                    await this.loadIssuesForRepository(this.filters.repo);
                    this.updateRepositoryDropdownCounts();
                } catch (error) {
                    this.showNotification(`Repository "${this.filters.repo}" not found on ModelEarth GitHub. Please check the repository name.`, 'error');
                    // Reset to 'all' filter to show available repositories
                    this.filters.repo = 'all';
                    return;
                }
            }

            // Filter and display issues for the selected repository
            this.filterAndDisplayIssues();
        }

        this.updateFilterUI();
    }

    async addCustomRepositoryFromHash(repoName) {
        // Check if repository already exists in the list
        const existingRepo = this.repositories.find(r => r.name === repoName);
        if (existingRepo) {
            return; // Already exists
        }


        // If repo doesn't contain a slash, assume it's in the modelearth account
        const fullRepoPath = repoName.includes('/') ? repoName : `${this.owner}/${repoName}`;
        const [owner, repo] = fullRepoPath.split('/');

        try {
            // Try to fetch repository info from GitHub API
            if (this.githubToken) {
                const repoInfo = await this.apiRequest(`/repos/${owner}/${repo}`);

                // Add to repositories list
                this.repositories.push({
                    name: repo,
                    displayName: repoInfo.name,
                    description: repoInfo.description || '',
                    defaultBranch: repoInfo.default_branch || 'main',
                    openIssueCount: repoInfo.open_issues_count || null,
                    totalIssueCount: null,
                    repository_url: repoInfo.html_url
                });


                // Update the dropdown to include the new repository
                this.populateRepositoryFilter();

            } else {
                // No token - add repository as placeholder
                this.repositories.push({
                    name: repo,
                    displayName: repo,
                    description: `Custom repository: ${fullRepoPath}`,
                    defaultBranch: 'main',
                    openIssueCount: null,
                    totalIssueCount: null,
                    repository_url: `https://github.com/${fullRepoPath}`
                });


                // Update the dropdown
                this.populateRepositoryFilter();
            }

        } catch (error) {

            // Don't add non-existent repositories to avoid confusion
            // The error will be handled in the calling function
            throw new Error(`Repository "${fullRepoPath}" not found on GitHub`);
        }
    }

    updateFilterUI() {
        // Update filter dropdowns and inputs
        document.getElementById('repoFilter').value = this.filters.repo;
        document.getElementById('searchInput').value = this.filters.search;

        this.updateSortButton();
        this.updateAssigneeButton();
        this.updateStateButton();
        this.updateLabelButton();

        if (this.filters.search) {
            document.getElementById('clearSearch').style.display = 'inline-block';
        }
    }

    updateSortButton() {
        const button = document.getElementById('sortButton');
        const sortNames = {
            updated: 'Updated',
            created: 'Created',
            comments: 'Comments',
            title: 'Title',
            number: 'Number'
        };
        button.innerHTML = `
            <i class="fas fa-sort"></i> Sort by: ${sortNames[this.filters.sort]}
            <i class="fas fa-chevron-down"></i>
        `;
    }

    updateAssigneeButton() {
        const button = document.getElementById('assigneeButton');
        let displayText = 'All';
        if (this.filters.assignee === 'unassigned') {
            displayText = 'Unassigned';
        } else if (this.filters.assignee !== 'all') {
            displayText = this.filters.assignee.split('-')[0];
        }

        // Check if container is narrow
        const container = button.closest('.filters-always-visible');
        const isNarrow = container && container.offsetWidth < 600;
        const labelText = isNarrow ? '' : 'Assigned to: ';

        button.innerHTML = `
            <i class="fas fa-user"></i> ${labelText}${displayText}
            <i class="fas fa-chevron-down"></i>
        `;
    }

    updateStateButton() {
        const button = document.getElementById('stateButton');
        const stateNames = {
            open: 'Active',
            closed: 'Closed',
            all: 'All'
        };
        const displayText = stateNames[this.filters.projectstatus] || 'Active';
        button.innerHTML = `
            <i class="fas fa-exclamation-circle"></i> ${displayText}
            <i class="fas fa-chevron-down"></i>
        `;
    }

    updateLabelButton() {
        const button = document.getElementById('labelButton');
        let displayText = this.filters.label === 'all' ? 'All' : this.filters.label;
        button.innerHTML = `
            <i class="fas fa-tags"></i> Labels: ${displayText}
            <i class="fas fa-chevron-down"></i>
        `;
    }

    saveToCache() {
        const cacheData = {
            filters: this.filters,
            repositories: this.repositories,
            issues: this.allIssues,
            timestamp: Date.now()
        };
        localStorage.setItem('github_issues_cache', JSON.stringify(cacheData));

        // Set up cache expiration timer for auto-refresh (only with token)
        if (this.cacheConfig.autoRefresh && this.githubToken) {
            this.setupCacheExpirationTimer(this.cacheConfig.duration * 60 * 1000);
        } else if (!this.githubToken) {
        }

        // Update cache status display
        this.updateCacheStatusDisplay();
    }

    saveViewPreference() {
        localStorage.setItem('github_issues_view', this.currentView);
    }

    loadViewPreference() {
        const savedView = localStorage.getItem('github_issues_view');
        if (savedView && (savedView === 'short' || savedView === 'list' || savedView === 'card')) {
            this.currentView = savedView;
            this.setView(savedView, false); // Don't save when loading
        }
    }

    toggleFullscreen() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        this.isFullscreen = !this.isFullscreen;

        if (this.isFullscreen) {
            // Enter fullscreen
            container.classList.add('widget-fullscreen');
            document.body.classList.add('widget-fullscreen-active');

            // Add minimize button to main header next to search icon
            const mainHeader = document.querySelector('.issues-header');
            if (mainHeader && !mainHeader.querySelector('.minimize-btn')) {
                const minimizeBtn = document.createElement('button');
                minimizeBtn.className = 'minimize-btn';
                minimizeBtn.innerHTML = '<i class="fas fa-compress"></i>';
                minimizeBtn.title = 'Exit Fullscreen';
                minimizeBtn.onclick = () => this.toggleFullscreen();
                mainHeader.appendChild(minimizeBtn);
            }

        } else {
            // Exit fullscreen
            container.classList.remove('widget-fullscreen');
            document.body.classList.remove('widget-fullscreen-active');

            // Remove minimize button
            const minimizeBtn = document.querySelector('.minimize-btn');
            if (minimizeBtn) {
                minimizeBtn.remove();
            }

        }

        // Update icon in pagination
        this.updatePagination();
    }

    toggleFilters() {
        const filtersSection = document.getElementById('filtersSection');
        const toggleBtn = document.querySelector('.toggle-filters-btn');
        const toggleText = document.querySelector('.toggle-text');

        if (!filtersSection) return;

        // Use the show-filters class instead of style.display to override !important CSS
        const isHidden = !filtersSection.classList.contains('show-filters');

        if (isHidden) {
            filtersSection.classList.add('show-filters');
            if (toggleBtn) toggleBtn.classList.add('active');
            if (toggleText) toggleText.textContent = 'Hide Filters';
        } else {
            filtersSection.classList.remove('show-filters');
            if (toggleBtn) toggleBtn.classList.remove('active');
            if (toggleText) toggleText.textContent = 'More Filters';
        }
    }

    hideFilters() {
        const filtersSection = document.getElementById('filtersSection');
        const toggleBtn = document.querySelector('.toggle-filters-btn');
        const toggleText = document.querySelector('.toggle-text');

        if (filtersSection) filtersSection.classList.remove('show-filters');
        if (toggleBtn) toggleBtn.classList.remove('active');
        if (toggleText) toggleText.textContent = 'More Filters';
    }

    // Issue menu functionality
    toggleIssueMenu(issueId, event) {
        if (event) {
            event.stopPropagation();
            event.preventDefault();
        }

        // Close all other open menus
        document.querySelectorAll('.issue-menu-dropdown').forEach(menu => {
            if (menu.id !== `issueMenu-${issueId}`) {
                menu.classList.remove('show');
            }
        });

        // Toggle current menu
        const menu = document.getElementById(`issueMenu-${issueId}`);
        if (menu) {
            menu.classList.toggle('show');
        }
    }

    async refreshSingleIssue(issueId) {
        try {
            // Close menu
            const menu = document.getElementById(`issueMenu-${issueId}`);
            if (menu) menu.classList.remove('show');

            // Find the issue in our current data
            const existingIssue = this.allIssues.find(issue => issue.id == issueId);
            if (!existingIssue) {
                this.showNotification('Issue not found', 'error');
                return;
            }

            // Show loading indicator on specific issue
            this.showIssueLoading(issueId, true);

            // Fetch fresh issue data from GitHub API
            const updatedIssue = await this.apiRequest(
                `/repos/${this.owner}/${existingIssue.repository}/issues/${existingIssue.number}`
            );

            // Preserve repository information
            updatedIssue.repository = existingIssue.repository;
            updatedIssue.repository_url = existingIssue.repository_url;

            // Update the issue in our data arrays
            this.updateIssueInCollections(updatedIssue);

            // Re-render only this specific issue
            this.rerenderSingleIssue(issueId, updatedIssue);

            // Update cache with new data
            this.saveToCache();

            this.showNotification(`Issue #${updatedIssue.number} refreshed`, 'success');

        } catch (error) {
            console.error('Error refreshing single issue:', error);
            if (error.name === 'AbortError') {
                this.showNotification('Refresh timed out', 'warning');
            } else if (error.message.includes('403')) {
                this.showNotification('API rate limit exceeded', 'error');
                // Flag that rate limit was exceeded for later token refresh detection
                localStorage.setItem('github_rate_limit_exceeded', 'true');
            } else {
                this.showNotification('Failed to refresh issue', 'error');
            }
        } finally {
            this.showIssueLoading(issueId, false);
        }
    }

    getRelativeGithubIconPath() {
        // Determine the relative path to localsite based on current page location
        const currentPath = window.location.pathname;
        const pathDepth = currentPath.split('/').filter(segment => segment !== '').length;

        // Calculate relative path climbing up from current location
        let relativePath = '';
        if (pathDepth > 1) {
            relativePath = '../'.repeat(pathDepth - 1);
        }

        return relativePath + 'localsite/img/icon/github/github.png';
    }

    expandIssueDetails(issueId, event) {
        // Prevent default link behavior
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        // Find the issue item by data attribute
        const issueItem = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (!issueItem) return;

        const fullDetailsDiv = issueItem.querySelector('.issue-full-details');
        const shortDescription = issueItem.querySelector('.short-description');

        if (fullDetailsDiv && shortDescription) {
            // Show full details inline
            fullDetailsDiv.style.display = 'block';
            shortDescription.style.display = 'none';
        }
    }

    collapseIssueDetails(issueId, event) {
        // Prevent default link behavior
        if (event && event.preventDefault) {
            event.preventDefault();
        }

        // Find the issue item by data attribute
        const issueItem = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (!issueItem) return;

        const fullDetailsDiv = issueItem.querySelector('.issue-full-details');
        const shortDescription = issueItem.querySelector('.short-description');

        if (fullDetailsDiv && shortDescription) {
            // Hide full details and show short description
            fullDetailsDiv.style.display = 'none';
            shortDescription.style.display = 'block';
        }
    }

    updateIssueInCollections(updatedIssue) {
        // Add last refreshed timestamp
        updatedIssue.last_refreshed = new Date().toISOString();

        // Update in main issues array
        const mainIndex = this.allIssues.findIndex(issue => issue.id == updatedIssue.id);
        if (mainIndex !== -1) {
            this.allIssues[mainIndex] = updatedIssue;
        }

        // Update in filtered array if present
        const filteredIndex = this.filteredIssues.findIndex(issue => issue.id == updatedIssue.id);
        if (filteredIndex !== -1) {
            this.filteredIssues[filteredIndex] = updatedIssue;
        }

        // Update repository-specific cache if exists
        if (this.repositoryIssues[updatedIssue.repository]) {
            const repoIndex = this.repositoryIssues[updatedIssue.repository].findIndex(
                issue => issue.id == updatedIssue.id
            );
            if (repoIndex !== -1) {
                this.repositoryIssues[updatedIssue.repository][repoIndex] = updatedIssue;
            }
        }
    }

    rerenderSingleIssue(issueId, updatedIssue) {
        const existingElement = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (existingElement) {
            // Create new element with updated data
            const newElement = this.createIssueElement(updatedIssue);

            // Replace existing element with smooth transition
            existingElement.style.opacity = '0.5';

            setTimeout(() => {
                existingElement.replaceWith(newElement);
                newElement.style.opacity = '0';
                newElement.offsetHeight; // Force reflow
                newElement.style.transition = 'opacity 0.3s ease';
                newElement.style.opacity = '1';
            }, 150);
        }
    }

    showIssueLoading(issueId, isLoading) {
        const issueElement = document.querySelector(`[data-issue-id="${issueId}"]`);
        if (issueElement) {
            if (isLoading) {
                issueElement.classList.add('issue-refreshing');
                // Add subtle loading indicator
                const loader = document.createElement('div');
                loader.className = 'issue-refresh-loader';
                loader.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i>';
                issueElement.appendChild(loader);
            } else {
                issueElement.classList.remove('issue-refreshing');
                const loader = issueElement.querySelector('.issue-refresh-loader');
                if (loader) loader.remove();
            }
        }
    }

    async copyIssueLink(url) {
        try {
            await navigator.clipboard.writeText(url);
            this.showNotification('Issue link copied to clipboard', 'success');
        } catch (error) {
            console.error('Failed to copy link:', error);
            this.showNotification('Failed to copy link', 'error');
        }
    }

    // Close menus when clicking outside
    setupMenuClickHandler() {
        document.addEventListener('click', (event) => {
            // Check if click is outside any issue menu
            if (!event.target.closest('.issue-actions-menu')) {
                document.querySelectorAll('.issue-menu-dropdown').forEach(menu => {
                    menu.classList.remove('show');
                });
            }
        });
    }

    loadFromCache() {
        try {
            const cached = localStorage.getItem('github_issues_cache');
            if (!cached) return null;

            const data = JSON.parse(cached);

            // Check if cache is less than configured duration old
            const maxAge = this.cacheConfig.duration * 60 * 1000; // Convert minutes to milliseconds
            const cacheAge = Date.now() - data.timestamp;
            if (cacheAge > maxAge) {
                return null;
            }

            if (data.filters) {
                this.filters = { ...this.filters, ...data.filters };
            }

            // Set up cache expiration timer if auto-refresh is enabled and we have a token
            if (this.cacheConfig.autoRefresh && this.githubToken) {
                this.setupCacheExpirationTimer(maxAge - cacheAge);
            } else if (!this.githubToken) {
            }

            return data;
        } catch (error) {
            console.warn('Failed to load from cache:', error);
            return null;
        }
    }

    // Repository-specific cache methods
    loadRepositoryFromCache(repoName, projectstatus = 'open') {
        try {
            const cacheKey = `github_repo_${repoName}_${projectstatus}_cache`;
            const cached = localStorage.getItem(cacheKey);
            if (!cached) return null;

            const data = JSON.parse(cached);

            // Check if cache is less than configured duration old
            const maxAge = this.cacheConfig.duration * 60 * 1000; // Convert minutes to milliseconds
            const cacheAge = Date.now() - data.timestamp;
            if (cacheAge > maxAge) {
                // Remove expired cache
                localStorage.removeItem(cacheKey);
                return null;
            }

            return data;
        } catch (error) {
            console.warn(`Failed to load repository ${repoName} from cache:`, error);
            return null;
        }
    }

    /**
     * DEFENSIVE CACHING IMPLEMENTATION - STRICT MODE
     * 
     * This function implements the requirement: "When there are no issues found, 
     * avoid saving any issues, so blank issues are not mistakes for saved actual 
     * issues when requests are available again."
     * 
     * KEY FEATURES:
     * 1. Always caches non-empty results (repositories with actual issues)
     * 2. NEVER caches empty results regardless of API status (strict defensive mode)
     * 3. Prevents false "no issues" states from being persisted in cache
     * 4. Stores API response metadata for debugging and future smart cache decisions
     * 
     * STRATEGY: Conservative approach - only cache when we have actual data
     * 
     * PREVENTS ALL SCENARIOS:
     * - Empty result from any cause → never cached → always fetches fresh on next request
     * - Ensures users always see real-time data when repositories actually have issues
     * - No risk of stale empty cache hiding legitimate issues
     */
    saveRepositoryToCache(repoName, issues, metadata, apiResponse = null, projectstatus = 'open') {
        try {
            // Defensive caching: Only cache when we're confident the data is legitimate
            const shouldCache = this.shouldCacheEmptyResult(issues, apiResponse);

            if (!shouldCache) {
                return;
            }

            const cacheKey = `github_repo_${repoName}_${projectstatus}_cache`;
            const cacheData = {
                issues: issues,
                metadata: metadata,
                timestamp: Date.now(),
                apiStatus: apiResponse ? {
                    status: apiResponse.status,
                    hasData: issues.length > 0,
                    rateLimitRemaining: apiResponse.rateLimitRemaining
                } : null
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (error) {
            console.warn(`Failed to save repository ${repoName} to cache:`, error);
        }
    }

    /**
     * Determines if empty results should be cached - STRICT DEFENSIVE MODE
     * NEVER caches empty results regardless of API status for maximum safety
     * 
     * STRICT POLICY - ALL SCENARIOS:
     * ✅ Cache: Non-empty results (repositories with actual issues) - ANY status
     * ❌ Don't Cache: Empty results (0 issues) - ALL statuses including 200 OK
     * 
     * REASONING: 
     * - Conservative approach prevents any false "no issues" cache states
     * - Always forces fresh API calls for empty results
     * - Eliminates risk of users missing legitimate issues due to cached empty states
     * - Better user experience at cost of slightly more API calls for empty repositories
     */
    shouldCacheEmptyResult(issues, apiResponse) {
        // If we have issues, always cache regardless of API status
        if (issues && issues.length > 0) {
            return true;
        }

        // STRICT DEFENSIVE MODE: NEVER cache empty results regardless of status
        return false;
    }


    clearRepositoryCache(repoName = null) {
        if (repoName) {
            // Clear cache for specific repository
            const cacheKey = `github_repo_${repoName}_cache`;
            localStorage.removeItem(cacheKey);
        } else {
            // Clear all repository caches
            const keys = Object.keys(localStorage);
            keys.forEach(key => {
                if (key.startsWith('github_repo_') && key.endsWith('_cache')) {
                    localStorage.removeItem(key);
                }
            });
        }
    }

    // Search functionality
    performSearch() {
        const searchInput = document.getElementById('searchInput');
        this.filters.search = searchInput.value.trim();
        this.currentPage = 1;
        this.updateHash();
        this.saveToCache();
        this.filterAndDisplayIssues();

        if (this.filters.search) {
            document.getElementById('clearSearch').style.display = 'inline-block';
        }
        this.updateSearchStatus();

    }



    clearSearch() {
        // clear the input + hide its X
        const input = document.getElementById('searchInput');
        const xBtn = document.getElementById('clearSearch');
        if (input) input.value = '';
        if (xBtn) xBtn.style.display = 'none';

        // wipe search & clear all filter buttons in one go
        this.filters.search = '';
        this.clearAllFilters();            // reuse existing logic

        // also hide the legacy "Clear All Filters" button permanently
        const oldClear = document.getElementById('clearAllFiltersBtn');
        if (oldClear) oldClear.style.display = 'none';
    }


    debouncedSearch(searchTerm) {
        // Clear previous timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Set new timer
        this.searchDebounceTimer = setTimeout(() => {
            this.filters.search = searchTerm.trim();
            this.currentPage = 1;
            this.updateHash();
            this.saveToCache();
            this.filterAndDisplayIssues();

            // Show/hide clear button
            const clearBtn = document.getElementById('clearSearch');
            if (this.filters.search) {
                clearBtn.style.display = 'inline-block';
            } else {
                clearBtn.style.display = 'none';
            }
        }, this.searchDebounceDelay);
        this.updateSearchStatus();

    }

    clearAllFilters() {
        // Clear the debounce timer
        if (this.searchDebounceTimer) {
            clearTimeout(this.searchDebounceTimer);
        }

        // Reset only filter buttons to default values (keep repo and search unchanged)
        this.filters.sort = 'updated';
        this.filters.assignee = 'all';
        this.filters.projectstatus = 'open';
        this.filters.label = 'all';

        // Update filter buttons
        this.updateSortButton();
        this.updateAssigneeButton();
        this.updateStateButton();
        this.updateLabelButton();

        // Reset pagination
        this.currentPage = 1;

        // Update URL and cache
        this.updateHash();
        this.saveToCache();

        // Apply filters
        this.filterAndDisplayIssues();

        // Show notification
        this.showNotification('Filter buttons cleared', 'info');

        // Update Clear All Filters button visibility
        this.updateClearAllFiltersVisibility();
        this.updateSearchStatus();

    }

    clearAllCache() {
        // Clear all cached repository issues
        this.repositoryIssues = {};
        this.repositoryIssueCounts = {};

        // Clear localStorage cache
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith('github_issues_') || key.startsWith('github_issue_counts_')) {
                localStorage.removeItem(key);
            }
        });

        // Reset warning flags to allow fresh error messages
        this.rateLimitWarningShown = false;
        this.invalidTokenWarningShown = false;

        // Show notification
        this.showNotification('Cache cleared successfully', 'success');

        // Reload current repository data
        if (this.filters.repo && this.filters.repo !== 'all') {
            this.loadIssuesForRepository(this.filters.repo);
        } else {
            this.loadData(true); // Force refresh all data
        }
    }

    // Check if any filter buttons are different from defaults and show/hide Clear All Filters button
    updateClearAllFiltersVisibility() {
        const clearAllBtn = document.getElementById('clearAllFiltersBtn');
        if (!clearAllBtn) return;

        // Define default values for filter buttons only (excluding repo and search)
        const defaults = {
            sort: 'updated',
            assignee: 'all',
            projectstatus: 'open',
            label: 'all'
        };

        // Check if any filter button differs from default
        const hasNonDefaultFilters = Object.keys(defaults).some(key => {
            return this.filters[key] !== defaults[key];
        });

        // Show/hide the Clear All Filters button
        if (hasNonDefaultFilters) {
            clearAllBtn.style.display = 'inline-block';
        } else {
            clearAllBtn.style.display = 'none';
        }
    }

    // View management
    setView(viewType, savePreference = true) {
        this.currentView = viewType;

        document.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById(viewType + 'View').classList.add('active');

        const issuesList = document.getElementById('issuesList');
        issuesList.className = `issues-list ${viewType}-view`;

        // Re-render issues with the new view
        this.displayIssues();

        // Save view preference to localStorage (unless loading from saved preference)
        if (savePreference) {
            this.saveViewPreference();
        }
    }

    // Filters expand/collapse management - commented out (now using header search button instead)
    /*
    expandFilters() {
        const filtersSection = document.getElementById('filtersSection');
        filtersSection.classList.add('expanded');
    }

    collapseFilters() {
        const filtersSection = document.getElementById('filtersSection');
        filtersSection.classList.remove('expanded');
    }
    */

    // UI helpers
    showLoading(show) {
        const issuesContainer = document.getElementById('issuesContainer');
        const issuesList = document.getElementById('issuesList');
        const loadingOverlay = document.getElementById('loadingOverlay');

        if (show) {
            // Show issues container and display loading inside it
            issuesContainer.style.display = 'block';
            issuesList.innerHTML = `
                <div class="loading-content">
                    <div class="spinner"></div>
                    <p>Loading GitHub data...</p>
                    <div class="loading-progress">
                        <div class="progress-bar" id="progressBar" style="width: 0%;"></div>
                    </div>
                    <p class="loading-status" id="loadingStatus">Fetching repositories...</p>
                </div>
            `;
            // Hide the overlay loading
            loadingOverlay.style.display = 'none';
        } else {
            // Hide the overlay loading (if it was showing)
            loadingOverlay.style.display = 'none';
            // Issues container will be managed by updateUI() method
        }
    }

    updateLoadingStatus(status) {
        document.getElementById('loadingStatus').textContent = status;
    }

    showError(message) {
        document.getElementById('errorMessage').style.display = 'block';
        document.getElementById('errorText').textContent = message;
        document.getElementById('filtersSection').style.display = 'none';
        document.getElementById('statsSection').style.display = 'none';
        document.getElementById('issuesContainer').style.display = 'none';
    }

    hideError() {
        document.getElementById('errorMessage').style.display = 'none';
    }

    showNotification(message, type = 'info') {
        // Check if this is a loading message that should be shown in issues container
        const isLoadingMessage = message.toLowerCase().includes('loading');

        if (isLoadingMessage) {
            // Show loading messages inside the issues container
            this.showInlineNotification(message, type);
        } else {
            // Show other notifications as floating (existing behavior)
            this.showFloatingNotification(message, type);
        }
    }

    showInlineNotification(message, type = 'info') {
        const issuesContainer = document.getElementById('issuesContainer');
        const issuesList = document.getElementById('issuesList');

        if (!issuesContainer || !issuesList) return;

        // Make sure issues container is visible
        issuesContainer.style.display = 'block';

        // Create notification element with subtle styling
        const notification = document.createElement('div');
        notification.className = `inline-notification ${type}`;

        // Use spinner for loading messages, other icons for other types
        const isLoadingMessage = message.toLowerCase().includes('loading');
        let iconHtml;

        if (isLoadingMessage) {
            iconHtml = '<i class="fas fa-spinner fa-spin inline-spinner"></i>';
        } else {
            const iconMap = {
                'success': 'check',
                'error': 'exclamation-triangle',
                'info': 'info'
            };
            const icon = iconMap[type] || 'info';
            iconHtml = `<i class="fas fa-${icon}-circle"></i>`;
        }

        notification.innerHTML = `
            ${iconHtml}
            ${message}
        `;

        // Clear any existing inline notifications
        const existingNotification = issuesList.querySelector('.inline-notification');
        if (existingNotification) {
            existingNotification.remove();
        }

        // Add to top of issues list
        issuesList.insertBefore(notification, issuesList.firstChild);

        // Auto-hide after 3 seconds
        setTimeout(() => {
            if (notification.parentNode) {
                notification.remove();
            }
        }, 3000);
    }

    showFloatingNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        const iconMap = {
            'success': 'check',
            'error': 'exclamation-triangle',
            'info': 'info'
        };
        const icon = iconMap[type] || 'info';

        notification.innerHTML = `
            <i class="fas fa-${icon}-circle"></i>
            ${message}
        `;

        // Add to page
        document.body.appendChild(notification);

        // Show and auto-hide
        setTimeout(() => notification.classList.add('show'), 10);
        setTimeout(() => {
            notification.classList.remove('show');
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    showFiltersOnError() {
        // Show basic UI elements even when API fails
        // Keep filters hidden by default - user can toggle with search button
        // document.getElementById('filtersSection').style.display = 'block';

        // Populate repository filter from loaded repositories
        this.populateRepositoryFilter();

        // Update rate limit display
        this.updateRateLimitDisplay();

        // Set basic stats
        document.getElementById('repoCount').textContent = '1';
        document.getElementById('openIssueCount').textContent = '?';
        document.getElementById('closedIssueCount').textContent = '?';
        document.getElementById('totalComments').textContent = '?';

        // Show stats section
        document.getElementById('statsSection').style.display = 'flex';

        // Show issues container with message
        document.getElementById('issuesContainer').style.display = 'block';
        document.getElementById('issuesList').innerHTML = `
            <div class="no-issues">
                <i class="fas fa-exclamation-triangle"></i>
                <h3>API Rate Limit Exceeded</h3>
                <p>GitHub API rate limit reached. Please try again later or add a GitHub token to increase your rate limit.</p>
                <p>You can still use the filters - they will work once the API is accessible again.</p>
            </div>
        `;

        // Hide pagination
        document.getElementById('paginationContainer').innerHTML = '';
    }
}

// Git Issues Account Management Functions
function updateGitIssuesAccount() {
    const gitIssuesAccount = document.getElementById("gitIssuesAccount").value;

    // Store in localStorage using same cache as other git fields - store even if empty to clear cache
    localStorage.gitAccount = gitIssuesAccount;

    // Update the display
    updateGitAccountDisplay();

    // Update assignee button default if needed
    updateAssigneeButtonDefault();
}

function updateGitAccountDisplay() {
    const gitAccount = localStorage.gitAccount || document.getElementById("gitIssuesAccount").value;
    const gitAccountDisplay = document.getElementById("gitAccountDisplay");
    const gitAccountLink = document.getElementById("gitAccountLink");

    if (gitAccount && gitAccount.trim() !== '' && gitAccountDisplay && gitAccountLink) {
        // Show GitHub account when available
        gitAccountLink.textContent = gitAccount;
        gitAccountLink.href = `https://github.com/${gitAccount}`;
        gitAccountDisplay.innerHTML = ` GitHub: <a href="https://github.com/${gitAccount}" id="gitAccountLink" onclick="toggleGitIssuesAccount(); return false;">${gitAccount}</a>`;
        gitAccountDisplay.style.display = 'inline';
    } else if (gitAccountDisplay && gitAccountLink) {
        // Show "Add my Github name" when no account is cached
        gitAccountDisplay.innerHTML = ` <a href="#" id="gitAccountLink" onclick="toggleGitIssuesAccount(); return false;">Add my Github name</a> - Will soon allow you to display your projects.`;
        gitAccountDisplay.style.display = 'inline';
    }
}

function toggleGitIssuesAccount() {
    const gitIssuesAccountField = document.getElementById("gitIssuesAccount");
    if (gitIssuesAccountField) {
        if (gitIssuesAccountField.style.display === 'none' || !gitIssuesAccountField.style.display) {
            gitIssuesAccountField.style.display = 'inline-block';
            gitIssuesAccountField.focus();
        } else {
            gitIssuesAccountField.style.display = 'none';
        }
    }
}

function updateAssigneeButtonDefault() {
    const gitAccount = localStorage.gitAccount;
    if (!gitAccount || !issuesManager) return;

    // Check if gitAccount exists in the assignees list
    if (issuesManager.assignees && issuesManager.assignees.has(gitAccount)) {
        // Only set as default if no other assignee value is cached
        const cachedAssignee = localStorage.getItem('issuesManager_assignee');
        if (!cachedAssignee || cachedAssignee === 'all') {
            issuesManager.filters.assignee = gitAccount;
            issuesManager.updateAssigneeButton();
        }
    }
}

// Initialize Git Issues Account on page load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const gitIssuesAccountField = document.getElementById("gitIssuesAccount");
        if (gitIssuesAccountField) {
            // Load from localStorage if available
            if (localStorage.gitAccount) {
                gitIssuesAccountField.value = localStorage.gitAccount;
            }

            // Add keypress event listener for clearing cache on Enter when field is empty
            gitIssuesAccountField.addEventListener('keypress', function (e) {
                if (e.key === 'Enter' && this.value.trim() === '') {
                    localStorage.removeItem('gitAccount');
                    updateGitIssuesAccount();
                }
            });
        }

        // Update the display initially
        updateGitAccountDisplay();
    }, 100);
});

// Initialize the issues manager when the page loads (auto-init for projects/hub page)
// For other pages (like team/projects), use manual initialization with minimalMode option
let issuesManager;
document.addEventListener('DOMContentLoaded', () => {
    // Check if there's a specific container, otherwise skip auto-init
    const container = document.getElementById('issuesWidget');
    if (container) {
        // Get container ID from data attribute or use default
        const containerId = container.dataset.containerId || 'issuesWidget';
        issuesManager = new GitHubIssuesManager(containerId);
        console.log('✅ Auto-initialized full GitHubIssuesManager widget');
    }
    // If no container found, skip auto-init (page may use manual initialization)
});
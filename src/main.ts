import {
  WorkspaceLeaf,
  Plugin,
  MarkdownPostProcessorContext,
  TFolder,
  TFile,
  ViewState,
  Platform,
  MarkdownView,
  addIcon,
} from "obsidian";

import { DatabaseView } from "views/DatabaseView";

import { DBFolderSettingTab, loadServicesThatRequireSettings } from "Settings";

import { DbfAPIInterface } from "typings/api";

import { DatabaseSettings, LocalSettings } from "cdm/SettingsModel";
import StateManager from "StateManager";
import { around } from "monkey-around";
import { LOGGER } from "services/Logger";
import {
  DatabaseCore,
  DATABASE_CONFIG,
  DB_ICONS,
  DEFAULT_SETTINGS,
  EMITTERS_GROUPS,
  YAML_INDENT,
} from "helpers/Constants";
import { PreviewDatabaseModeService } from "services/MarkdownPostProcessorService";
import { unmountComponentAtNode } from "react-dom";
import { isDatabaseNote } from "helpers/VaultManagement";
import { getParentWindow } from "helpers/WindowElement";
import { DatabaseHelperCreationModal } from "commands/addDatabaseHelper/databaseHelperCreationModal";
import {
  generateDbConfiguration,
  generateNewDatabase,
} from "helpers/CommandsHelper";
import { registerDateFnLocale, t } from "lang/helpers";
import ProjectAPI from "api/obsidian-projects-api";
import { Db } from "services/CoreService";
import { CustomView } from "views/AbstractView";

interface WindowRegistry {
  viewMap: Map<string, CustomView>;
  viewStateReceivers: Array<(views: CustomView[]) => void>;
  appRoot: HTMLElement;
}

export default class DBFolderPlugin extends Plugin {
  /** Plugin-wide default settings. */
  public settings: DatabaseSettings;

  /** External-facing plugin API */
  public api: DbfAPIInterface;

  onRegisterProjectView = () => new ProjectAPI(this);
  public hover: { linkText: string; sourcePath: string } = {
    linkText: null,
    sourcePath: null,
  };

  databaseFileModes: Record<string, string> = {};

  _loaded = false;

  stateManagers: Map<TFile, StateManager> = new Map();

  windowRegistry: Map<Window, WindowRegistry> = new Map();

  ribbonIcon: HTMLElement;

  statusBarItem: HTMLElement;

  async onload(): Promise<void> {
    await this.load_settings();
    await this.loadServices();
    addIcon(DB_ICONS.NAME, DB_ICONS.ICON);
    this.registerEvent(
      app.workspace.on("window-open", (_: unknown, win: Window) => {
        this.mount(win);
      })
    );

    this.registerEvent(
      app.workspace.on("window-close", (_: unknown, win: Window) => {
        this.unmount(win);
      })
    );

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(
      new DBFolderSettingTab(this, {
        onSettingsChange: async (newSettings) => {
          this.settings = newSettings;
          await this.saveSettings();

          //Force a complete re-render when settings change
          this.stateManagers.forEach((stateManager) => {
            stateManager.forceRefresh();
          });
        },
      })
    );

    this.registerView(
      DatabaseCore.FRONTMATTER_KEY,
      (leaf) => new DatabaseView(leaf, this)
    );
    this.registerEvents();
    this.registerCommands();
    this.registerMonkeyPatches();
    this.addMarkdownPostProcessor();
    this.registerLocale();
    // Mount an empty component to start; views will be added as we go
    this.mount(window);
  }

  unload(): void {
    Promise.all(
      app.workspace
        .getLeavesOfType(DatabaseCore.FRONTMATTER_KEY)
        .map((leaf) => {
          this.databaseFileModes[leaf.id] = "markdown";
          return this.setMarkdownView(leaf);
        })
    ).then(() => {
      super.unload();
    });
  }

  async onunload() {
    LOGGER.info("Unloading DBFolder plugin");

    this.windowRegistry.forEach((reg, win) => {
      reg.viewStateReceivers.forEach((fn) => fn([]));
      this.unmount(win);
    });

    this.unmount(window);

    this.stateManagers.clear();
    this.windowRegistry.clear();
    this.databaseFileModes = {};

    app.workspace.unregisterHoverLinkSource(DatabaseCore.FRONTMATTER_KEY);
  }

  /** Update plugin settings. */
  async updateSettings(settings: Partial<DatabaseSettings>) {
    Object.assign(this.settings, settings);
    await this.saveData(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async load_settings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    loadServicesThatRequireSettings(this.settings);
  }

  async loadServices() {
    await Db.init();
  }

  public registerPriorityCodeblockPostProcessor(
    language: string,
    priority: number,
    processor: (
      source: string,
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext
    ) => Promise<void>
  ) {
    const registered = this.registerMarkdownCodeBlockProcessor(
      language,
      processor
    );
    registered.sortOrder = priority;
  }

  async setDatabaseView(leaf: WorkspaceLeaf) {
    await leaf.setViewState({
      type: DatabaseCore.FRONTMATTER_KEY,
      state: leaf.view.getState(),
      popstate: true,
    } as ViewState);
  }

  viewStateReceivers: Array<(views: CustomView[]) => void> = [];

  addView(view: CustomView) {
    const win = view.getWindow();
    const reg = this.windowRegistry.get(win);

    if (!reg) {
      return;
    }

    if (!reg.viewMap.has(view.id)) {
      reg.viewMap.set(view.id, view);
    }

    const file = view.file;
    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).registerView(view);
    } else {
      this.stateManagers.set(
        file,
        new StateManager(
          view,
          () => this.stateManagers.delete(file),
          () => this.settings
        )
      );
    }
    reg.viewStateReceivers.forEach((fn) => fn(this.getDatabaseViews(win)));
  }

  getStateManager(file: TFile) {
    return this.stateManagers.get(file);
  }

  getStateManagerFromViewID(id: string, win: Window) {
    const view = this.getDatabaseView(id, win);

    if (!view) {
      return null;
    }

    return this.stateManagers.get(view.file);
  }

  removeView(view: CustomView) {
    const entry = Array.from(this.windowRegistry.entries()).find(([, reg]) => {
      return reg.viewMap.has(view.id);
    }, []);

    if (!entry) {
      return;
    }

    const [win, reg] = entry;
    const file = view.file;

    if (reg.viewMap.has(view.id)) {
      reg.viewMap.delete(view.id);
    }

    if (this.stateManagers.has(file)) {
      this.stateManagers.get(file).unregisterView(view);
      reg.viewStateReceivers.forEach((fn) => fn(this.getDatabaseViews(win)));
    }
  }

  unmount(win: Window) {
    if (!this.windowRegistry.has(win)) {
      return;
    }

    const reg = this.windowRegistry.get(win);

    for (const view of reg.viewMap.values()) {
      view.destroy();
    }

    unmountComponentAtNode(reg.appRoot);

    reg.appRoot.remove();
    reg.viewMap.clear();
    reg.viewStateReceivers.length = 0;
    reg.appRoot = null;

    this.windowRegistry.delete(win);
  }

  async setMarkdownView(leaf: WorkspaceLeaf, focus = true) {
    await leaf.setViewState(
      {
        type: "markdown",
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus }
    );
  }

  getDatabaseViews(win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg) {
      return Array.from(reg.viewMap.values());
    }

    return [];
  }

  getDatabaseView(id: string, win: Window) {
    const reg = this.windowRegistry.get(win);

    if (reg?.viewMap.has(id)) {
      return reg.viewMap.get(id);
    }

    for (const reg of this.windowRegistry.values()) {
      if (reg.viewMap.has(id)) {
        return reg.viewMap.get(id);
      }
    }

    return null;
  }

  mount(win: Window) {
    if (this.windowRegistry.has(win)) {
      return;
    }

    const el = win.document.body.createDiv();

    this.windowRegistry.set(win, {
      viewMap: new Map(),
      viewStateReceivers: [],
      appRoot: el,
    });
  }

  /**
   * Returns the default configuration for a database file.
   */
  defaultConfiguration(): string {
    const local_settings = this.settings.local_settings;
    const defaultConfig = [];
    defaultConfig.push("config:");
    Object.entries(DEFAULT_SETTINGS.local_settings).forEach(([key, value]) => {
      const defaultValue =
        local_settings[key as keyof LocalSettings] !== undefined
          ? local_settings[key as keyof LocalSettings]
          : value;
      defaultConfig.push(`${YAML_INDENT}${key}: ${defaultValue}`);
    });
    defaultConfig.push(DATABASE_CONFIG.END_CENTINEL);
    return defaultConfig.join("\n");
  }

  registerEvents() {
    this.registerEvent(
      app.workspace.on("file-menu", (menu, file: TFile, source, leaf) => {
        // Add a menu item to the folder context menu to create a database
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle(t("menu_pane_create_db"))
              .setIcon(DB_ICONS.NAME)
              .onClick(() =>
                generateNewDatabase(
                  generateDbConfiguration(this.settings.local_settings),
                  file
                )
              );
          });
          return;
        }
        if (
          !Platform.isMobile &&
          file instanceof TFile &&
          leaf &&
          source === "sidebar-context-menu" &&
          isDatabaseNote(file)
        ) {
          const views = this.getDatabaseViews(
            getParentWindow(leaf.view.containerEl)
          );

          const haveDatabaseView = views.some((view) => {
            if (view.file === file) {
              view.onPaneMenu(menu, "more-options", false);
              return true;
            }
            return false;
          });
          if (!haveDatabaseView) {
            menu.addItem((item) => {
              item
                .setTitle(t("menu_pane_open_as_db_action"))
                .setIcon(DB_ICONS.NAME)
                .setSection("pane")
                .onClick(() => {
                  this.databaseFileModes[leaf.id || file.path] =
                    DatabaseCore.FRONTMATTER_KEY;
                  this.setDatabaseView(leaf);
                });
            });
            return;
          }
        }

        if (
          leaf?.view instanceof MarkdownView &&
          file instanceof TFile &&
          source === "pane-more-options" &&
          isDatabaseNote(file)
        ) {
          menu.addItem((item) => {
            item
              .setTitle(t("menu_pane_open_as_db_action"))
              .setIcon(DB_ICONS.NAME)
              .setSection("pane")
              .onClick(() => {
                this.databaseFileModes[leaf.id || file.path] =
                  DatabaseCore.FRONTMATTER_KEY;
                this.setDatabaseView(leaf);
              });
          });
        }
      })
    );

    /**
     * When the Dataview index is ready, trigger the index ready event.
     */
    this.registerEvent(
      app.metadataCache.on("dataview:index-ready", async () => {
        const initView = app.workspace.getActiveViewOfType(DatabaseView);
        if (initView) {
          await initView.reloadDatabase();
        }
        /**
         * Once the index is ready, we can start listening for metadata changes.
         */
        if (this.settings.global_settings.enable_auto_update) {
          // Delay the registration of the event to allow the index to be ready entirely
          setTimeout(() => {
            this.registerEvent(
              app.metadataCache.on(
                "dataview:metadata-change",
                (type, file, oldPath?) => {
                  const activeView =
                    app.workspace.getActiveViewOfType(DatabaseView);
                  Array.from(this.windowRegistry.entries()).forEach(
                    async ([, { viewMap }]) => {
                      // Iterate through all the views and reload the database if the file is the same
                      viewMap.forEach(async (view) => {
                        const isActive =
                          activeView &&
                          view.file.path === activeView?.file.path;
                        view.handleExternalMetadataChange(
                          type,
                          file,
                          isActive,
                          oldPath
                        );
                      });
                    }
                  );
                }
              )
            );
          }, 2500);
        }
      })
    );

    /**
     * Check when the active view focus changes and update bar status
     */
    this.registerEvent(
      app.workspace.on("active-leaf-change", () => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);
        if (!activeView && this.statusBarItem) {
          this.statusBarItem.detach();
          this.statusBarItem = null;
        } else if (activeView && this.statusBarItem) {
          activeView.handleUpdateStatusBar();
        }
      })
    );
  }

  registerCommands() {
    // Creator Helper Command
    this.addCommand({
      id: "create-new-database-folder",
      name: t("ribbon_icon_title"),
      callback: () =>
        new DatabaseHelperCreationModal(this.settings.local_settings).open(),
    });

    // Active View Go Next Page
    this.addCommand({
      id: "active-database-folder-go-next-page",
      name: t("active_go_next_page"),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);

        if (!activeView) return false;
        if (checking) return true;
        activeView.goNextPage();
      },
    });

    // Active View Go Previous Page
    this.addCommand({
      id: "active-database-folder-go-previous-page",
      name: t("active_go_previous_page"),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);

        if (!activeView) return false;
        if (checking) return true;
        activeView.goPreviousPage();
      },
    });

    // Active View Add New Row Modal
    this.addCommand({
      id: "active-database-folder-add-new-row",
      name: t("active_add_new_row"),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);

        if (!activeView) return false;
        if (checking) return true;
        activeView.addNewRow();
      },
    });

    // Active View Open Settings
    this.addCommand({
      id: "active-database-folder-open-settings",
      name: t("active_open_settings"),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);

        if (!activeView) return false;
        if (checking) return true;
        activeView.settingsAction();
      },
    });

    // Active View Enable/Disable Filters
    this.addCommand({
      id: "active-database-folder-toggle-filters",
      name: t("active_toggle_filters"),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);

        if (!activeView) return false;
        if (checking) return true;
        activeView.toggleFilters();
      },
    });

    // Active View Open Filters Modal
    this.addCommand({
      id: "active-database-folder-open-filters",
      name: t("active_open_filters"),
      checkCallback: (checking) => {
        const activeView = app.workspace.getActiveViewOfType(DatabaseView);

        if (!activeView) return false;
        if (checking) return true;
        activeView.openFilters();
      },
    });

    // Ribbon Icon
    this.showRibbonIcon();
  }

  showRibbonIcon() {
    this.ribbonIcon = this.addRibbonIcon(
      DB_ICONS.NAME,
      t("ribbon_icon_title"),
      async () => {
        new DatabaseHelperCreationModal(this.settings.local_settings).open();
      }
    );
  }
  /**
   * Displays a transcluded .excalidraw image in markdown preview mode
   */
  private addMarkdownPostProcessor() {
    const previewMode = PreviewDatabaseModeService.getInstance(this);
    this.registerMarkdownPostProcessor(previewMode.markdownPostProcessor);

    // internal-link quick preview
    this.registerEvent(
      app.workspace.on("quick-preview", previewMode.hoverEvent)
    );
  }

  /**
   * Wrap Obsidian functionalities to add the database support needed
   */
  registerMonkeyPatches() {
    const self = this;

    // Monkey patch to manage hotkey emitters
    app.workspace.onLayoutReady(() => {
      this.register(
        around((app as any).commands, {
          executeCommand(next) {
            return function (command: any) {
              const view = app.workspace.getActiveViewOfType(DatabaseView);

              if (view && command?.id) {
                view.emitter.emit(EMITTERS_GROUPS.HOTKEY, command.id);
              }

              return next.call(this, command);
            };
          },
        })
      );
    });

    // Monkey patch WorkspaceLeaf to open Databases with DatabaseView by default
    this.register(
      around(WorkspaceLeaf.prototype, {
        // Databases can be viewed as markdown or Database, and we keep track of the mode
        // while the file is open. When the file closes, we no longer need to keep track of it.
        detach(next) {
          return function () {
            const state = this.view?.getState();

            if (state?.file && self.databaseFileModes[this.id || state.file]) {
              delete self.databaseFileModes[this.id || state.file];
            }

            return next.apply(this);
          };
        },

        setViewState(next) {
          return function (state: ViewState, ...rest: any[]) {
            if (
              // Don't force Databases mode during shutdown
              self._loaded &&
              // If we have a markdown file
              state.type === "markdown" &&
              state.state?.file &&
              // And the current mode of the file is not set to markdown
              self.databaseFileModes[this.id || state.state.file] !== "markdown"
            ) {
              // Then check for the database frontMatterKey
              const cache = app.metadataCache.getCache(state.state.file);

              if (
                cache?.frontmatter &&
                cache.frontmatter[DatabaseCore.FRONTMATTER_KEY]
              ) {
                // If we have it, force the view type to database
                const newState = {
                  ...state,
                  type: DatabaseCore.FRONTMATTER_KEY,
                };

                self.databaseFileModes[state.state.file] =
                  DatabaseCore.FRONTMATTER_KEY;

                return next.apply(this, [newState, ...rest]);
              }
            }

            return next.apply(this, [state, ...rest]);
          };
        },
      })
    );
  }
  /**
   * Register language used in the plugin
   */
  async registerLocale() {
    registerDateFnLocale();
  }
}

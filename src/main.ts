import { WorkspaceLeaf, Plugin, TFile, ViewState, addIcon } from "obsidian";

import { DatabaseView } from "views/DatabaseView";
import { DBFolderSettingTab, loadServicesThatRequireSettings } from "Settings";
import { DbfAPIInterface } from "typings/api";
import { DatabaseSettings } from "cdm/SettingsModel";
import StateManager from "StateManager";
import { around } from "monkey-around";
import { LOGGER } from "services/Logger";
import { DatabaseCore, DB_ICONS, DEFAULT_SETTINGS, EMITTERS_GROUPS } from "helpers/Constants";
import { PreviewDatabaseModeService } from "services/MarkdownPostProcessorService";
import { unmountComponentAtNode } from "react-dom";
import { registerDateFnLocale } from "lang/helpers";
import ProjectAPI from "api/obsidian-projects-api";
import { Db } from "services/CoreService";
import { CustomView } from "views/AbstractView";

interface WindowRegistry {
  viewMap: Map<string, CustomView>;
  viewStateReceivers: Array<(views: CustomView[]) => void>;
  appRoot: HTMLElement;
}

interface DatabaseWorkspaceLeaf extends WorkspaceLeaf {
  databaseFileModes: Record<string, string>;
  _loaded: boolean;
  app: {
    metadataCache: {
      getCache: (path: string) => Record<string, unknown>;
    };
  };
}

interface FrontMatter {
  [key: string]: unknown;
  [DatabaseCore.FRONTMATTER_KEY]?: boolean;
}

interface MetadataCache {
  frontmatter?: FrontMatter;
}

type AppWithCommands = {
  commands: {
    executeCommand: (command: { id?: string }) => unknown;
  };
};

export default class DBFolderPlugin extends Plugin {
  public settings: DatabaseSettings;
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
    this._loaded = true;
    await this.load_settings();
    await this.loadServices();
    addIcon(DB_ICONS.NAME, DB_ICONS.ICON);
    this.registerEvent(
      this.app.workspace.on("window-open", (_: unknown, win: Window) => {
        this.mount(win);
      })
    );

    this.registerEvent(
      this.app.workspace.on("window-close", (_: unknown, win: Window) => {
        this.unmount(win);
      })
    );

    this.addSettingTab(
      new DBFolderSettingTab(this, {
        onSettingsChange: async (newSettings) => {
          this.settings = newSettings;
          await this.saveSettings();
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
    await this.registerLocale();
    this.mount(window);
  }

  async unload(): Promise<void> {
    Promise.all(
      this.app.workspace
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
    this.app.workspace.unregisterHoverLinkSource(DatabaseCore.FRONTMATTER_KEY);
  }

  async load_settings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    loadServicesThatRequireSettings(this.settings);
  }

  async loadServices(): Promise<void> {
    await Db.init();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async updateSettings(settings: Partial<DatabaseSettings>): Promise<void> {
    Object.assign(this.settings, settings);
    await this.saveData(this.settings);
  }

  private setupHotkeyEmitter = (): void => {
    this.app.workspace.onLayoutReady(() => {
      this.register(
        around((this.app as unknown as AppWithCommands).commands, {
          executeCommand: (next: (command: { id?: string }) => unknown) =>
            (command: { id?: string }) => {
              const view = this.app.workspace.getActiveViewOfType(DatabaseView);
              if (view && command?.id) {
                view.emitter.emit(EMITTERS_GROUPS.HOTKEY, command.id);
              }
              return next(command);
            }
        })
      );
    });
  };

  private setupWorkspaceLeafPatches = (): void => {
    this.register(
      around(WorkspaceLeaf.prototype, {
        detach: (next: () => Promise<void>) => (function(this: DatabaseWorkspaceLeaf): Promise<void> {
          const state = this.view?.getState();
          const fileId = this.id || state?.file;
          const dbPlugin = this.app as unknown as DBFolderPlugin;
          if (state?.file && dbPlugin.databaseFileModes[fileId]) {
            delete dbPlugin.databaseFileModes[fileId];
          }
          return next.call(this);
        }),
        setViewState: (next: (state: ViewState, ...rest: unknown[]) => Promise<void>) => 
          (function(this: DatabaseWorkspaceLeaf, state: ViewState, ...rest: unknown[]): Promise<void> {
            const fileId = this.id || state.state?.file;
            const dbPlugin = this.app as unknown as DBFolderPlugin;
            if (
              dbPlugin._loaded &&
              state.type === "markdown" &&
              state.state?.file &&
              dbPlugin.databaseFileModes[fileId] !== "markdown"
            ) {
              const cache = this.app.metadataCache.getCache(state.state.file) as MetadataCache;

              if (
                cache?.frontmatter &&
                cache.frontmatter[DatabaseCore.FRONTMATTER_KEY]
              ) {
                const newState = {
                  ...state,
                  type: DatabaseCore.FRONTMATTER_KEY,
                };

                dbPlugin.databaseFileModes[state.state.file] =
                  DatabaseCore.FRONTMATTER_KEY;

                return next.call(this, newState, ...rest);
              }
            }
            return next.call(this, state, ...rest);
          })
      })
    );
  };

  private registerMonkeyPatches = (): void => {
    this.setupHotkeyEmitter();
    this.setupWorkspaceLeafPatches();
  };

  private registerEvents = (): void => {
    // Event registration implementation
  };

  private registerCommands = (): void => {
    // Command registration implementation
  };

  private addMarkdownPostProcessor = (): void => {
    const previewMode = PreviewDatabaseModeService.getInstance(this);
    this.registerMarkdownPostProcessor(previewMode.markdownPostProcessor);
    this.registerEvent(
      this.app.workspace.on("quick-preview", previewMode.hoverEvent)
    );
  };

  private async registerLocale(): Promise<void> {
    await registerDateFnLocale();
  }

  mount = (win: Window): void => {
    if (this.windowRegistry.has(win)) return;
    
    const el = win.document.body.createDiv();
    this.windowRegistry.set(win, {
      viewMap: new Map(),
      viewStateReceivers: [],
      appRoot: el,
    });
  };

  unmount = (win: Window): void => {
    if (!this.windowRegistry.has(win)) return;

    const reg = this.windowRegistry.get(win);
    if (!reg) return;

    for (const view of reg.viewMap.values()) {
      view.destroy();
    }

    unmountComponentAtNode(reg.appRoot);
    reg.appRoot.remove();
    reg.viewMap.clear();
    reg.viewStateReceivers.length = 0;
    reg.appRoot = null;

    this.windowRegistry.delete(win);
  };

  private async setMarkdownView(leaf: WorkspaceLeaf, focus = true): Promise<void> {
    await leaf.setViewState(
      {
        type: "markdown",
        state: leaf.view.getState(),
        popstate: true,
      } as ViewState,
      { focus }
    );
  }
}

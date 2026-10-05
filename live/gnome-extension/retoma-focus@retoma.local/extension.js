// extension.js — Retoma focus exporter (GNOME Shell 45+ ESM style).
// Owns org.retoma.Focus and exports /org/retoma/Focus so the Retoma
// desktop app can follow the user's real focused window on Wayland,
// where org.gnome.Shell.Introspect.GetWindows is AccessDenied to apps.
// Signals FocusChanged(appId, appName, title) on every focus/title change.
// Never records keystrokes or screen content. No timers left behind.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

const BUS_NAME = 'org.retoma.Focus';
const OBJECT_PATH = '/org/retoma/Focus';
const IFACE_NAME = 'org.retoma.Focus';

const IFACE_XML = `
<node>
  <interface name="org.retoma.Focus">
    <method name="GetFocus">
      <arg type="s" name="appId" direction="out"/>
      <arg type="s" name="appName" direction="out"/>
      <arg type="s" name="title" direction="out"/>
    </method>
    <signal name="FocusChanged">
      <arg type="s" name="appId"/>
      <arg type="s" name="appName"/>
      <arg type="s" name="title"/>
    </signal>
  </interface>
</node>`;

// Pure-ish read of the current focus. Every step is guarded so a
// missing window, tracker or app never throws out of the signal path.
function readFocus() {
    let appId = '';
    let appName = '';
    let title = '';
    try {
        const display = global.display;
        const win = display ? display.focus_window : null;
        if (!win)
            return {appId, appName, title};
        try {
            appId = win.get_gtk_application_id() || '';
        } catch (_) {
            appId = '';
        }
        if (!appId) {
            try {
                appId = win.get_wm_class() || '';
            } catch (_) {
                appId = '';
            }
        }
        try {
            title = win.get_title() || '';
        } catch (_) {
            title = '';
        }
        try {
            const tracker = Shell.WindowTracker.get_default();
            const app = tracker ? tracker.get_window_app(win) : null;
            if (app)
                appName = app.get_name() || '';
        } catch (_) {
            appName = '';
        }
        if (!appName)
            appName = appId;
    } catch (_) {
        // fall through with empty strings
    }
    return {appId, appName, title};
}

export default class RetomaFocusExtension extends Extension {
    enable() {
        this._exported = null;
        this._busId = 0;
        this._displayHandler = 0;
        this._titleHandler = 0;
        this._titleWindow = null;
        this._last = {appId: '\0', appName: '\0', title: '\0'};

        const impl = {
            GetFocus: () => {
                const f = readFocus();
                return new GLib.Variant('(sss)', [f.appId, f.appName, f.title]);
            },
        };
        this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, impl);
        this._exported.export(Gio.DBus.session, OBJECT_PATH);
        this._busId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            null,
            null,
            null
        );

        this._displayHandler = global.display.connect(
            'notify::focus-window',
            () => this._onFocusWindow()
        );
        this._trackTitle(global.display.focus_window);
        this._emitFocus();
    }

    disable() {
        if (this._displayHandler && global.display) {
            try {
                global.display.disconnect(this._displayHandler);
            } catch (_) {
                // already gone
            }
        }
        this._displayHandler = 0;
        this._untrackTitle();
        if (this._busId) {
            Gio.bus_unown_name(this._busId);
            this._busId = 0;
        }
        if (this._exported) {
            try {
                this._exported.unexport();
            } catch (_) {
                // already unexported
            }
            this._exported = null;
        }
        this._last = null;
    }

    _onFocusWindow() {
        this._trackTitle(global.display.focus_window);
        this._emitFocus();
    }

    _trackTitle(win) {
        this._untrackTitle();
        if (!win)
            return;
        try {
            this._titleWindow = win;
            this._titleHandler = win.connect(
                'notify::title',
                () => this._emitFocus()
            );
        } catch (_) {
            this._titleWindow = null;
            this._titleHandler = 0;
        }
    }

    _untrackTitle() {
        if (this._titleHandler && this._titleWindow) {
            try {
                this._titleWindow.disconnect(this._titleHandler);
            } catch (_) {
                // window already gone
            }
        }
        this._titleHandler = 0;
        this._titleWindow = null;
    }

    _emitFocus() {
        if (!this._exported)
            return;
        const f = readFocus();
        if (this._last &&
            f.appId === this._last.appId &&
            f.appName === this._last.appName &&
            f.title === this._last.title)
            return;
        this._last = f;
        try {
            Gio.DBus.session.emit_signal(
                null,
                OBJECT_PATH,
                IFACE_NAME,
                'FocusChanged',
                new GLib.Variant('(sss)', [f.appId, f.appName, f.title])
            );
        } catch (_) {
            // session bus gone; disable() cleans up
        }
    }
}

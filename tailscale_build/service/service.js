process.env.NODE_PATH = '/usr/lib/node_modules:' + (process.env.NODE_PATH || '');
require('module').Module._initPaths();

var Service = require('webos-service');
var pkgInfo = require('./package.json');
var child_process = require('child_process');
var fs = require('fs');
var path = require('path');

var service = new Service(pkgInfo.name);

var baseDir = __dirname;
var defaultBinDir = path.join(baseDir, 'bin');
var customBinDir = '/media/developer/temp/tailscale_bin';

var stateDir = path.join(baseDir, 'data');
var stateFile = path.join(stateDir, 'tailscaled.state');
var configFile = path.join(stateDir, 'config.json');
var socketFile = '/tmp/tailscaled.sock';

try {
    if (!fs.existsSync(stateDir)) {
        fs.mkdirSync(stateDir);
    }
} catch (e) {
    stateFile = '/tmp/tailscaled.state';
}

function getTailscaleBin() {
    var custom = path.join(customBinDir, 'tailscale');
    if (fs.existsSync(custom)) {
        return custom;
    }
    return path.join(defaultBinDir, 'tailscale');
}

function getTailscaledBin() {
    var custom = path.join(customBinDir, 'tailscaled');
    if (fs.existsSync(custom)) {
        return custom;
    }
    return path.join(defaultBinDir, 'tailscaled');
}

var config = {
    enabled: true,
    autostart: true
};

function loadConfig() {
    try {
        if (fs.existsSync(configFile)) {
            var data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (typeof data.enabled === 'boolean') config.enabled = data.enabled;
            if (typeof data.autostart === 'boolean') config.autostart = data.autostart;
        }
    } catch (e) {}
}

function saveConfig() {
    try {
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    } catch (e) {}
}

loadConfig();

function ensurePermissions() {
    try {
        fs.chmodSync(getTailscaledBin(), '0755');
        fs.chmodSync(getTailscaleBin(), '0755');
    } catch (e) {}
}

function stopAll() {
    try {
        child_process.execFile('/usr/bin/pkill', ['-9', '-f', 'tailscaled'], function () {});
    } catch (e) {}
    try {
        child_process.execFile('/usr/bin/pkill', ['-9', '-f', 'tailscale'], function () {});
    } catch (e) {}
}

function startDaemon(cb) {
    ensurePermissions();
    if (!config.enabled) {
        if (cb) cb();
        return;
    }

    var tailscaleBin = getTailscaleBin();
    var tailscaledBin = getTailscaledBin();

    child_process.execFile(tailscaleBin, ['--socket=' + socketFile, 'status'], { timeout: 2000 }, function (err, stdout, stderr) {
        if (!err || (stdout && stdout.indexOf('Logged out') !== -1)) {
            startWeb(cb);
            return;
        }

        var args = [
            '--tun=userspace-networking',
            '--socks5-server=127.0.0.1:1055',
            '--outbound-http-proxy-listen=127.0.0.1:1055',
            '--state=' + stateFile,
            '--socket=' + socketFile
        ];

        try {
            var daemon = child_process.spawn(tailscaledBin, args, {
                detached: true,
                stdio: 'ignore'
            });
            daemon.unref();
        } catch (spawnErr) {
            console.error('Spawn tailscaled error:', spawnErr);
        }

        setTimeout(function () {
            startWeb(cb);
        }, 1500);
    });
}

function startWeb(cb) {
    ensurePermissions();
    if (!config.enabled) {
        if (cb) cb();
        return;
    }
    try {
        var web = child_process.spawn(getTailscaleBin(), ['--socket=' + socketFile, 'web', '--listen=127.0.0.1:8088'], {
            detached: true,
            stdio: 'ignore'
        });
        web.unref();
    } catch (e) {}
    if (cb) setTimeout(cb, 500);
}

function syncActivity() {
    if (!config.autostart || !config.enabled) {
        try {
            service.call('luna://com.webos.service.activitymanager/cancel', {
                activityName: 'com.tailscale.webos.autostart'
            }, function () {});
        } catch (e) {}
        return;
    }

    try {
        service.call('luna://com.webos.service.activitymanager/create', {
            activity: {
                name: 'com.tailscale.webos.autostart',
                description: 'Tailscale autostart and network watcher',
                type: { background: true, persist: true, explicit: true },
                trigger: { method: 'luna://com.webos.service.connectionmanager/getStatus' },
                callback: { method: 'luna://com.tailscale.webos.service/keepalive', params: {} }
            },
            start: true,
            replace: true
        }, function () {});
    } catch (e) {}
}

// Watchdog
setInterval(function () {
    if (!config.enabled) return;

    child_process.execFile(getTailscaleBin(), ['--socket=' + socketFile, 'status'], { timeout: 3000 }, function (err, stdout, stderr) {
        if (err && (!stdout || stdout.indexOf('Logged out') === -1)) {
            console.log('Watchdog: tailscaled down, restarting...');
            startDaemon();
        }
    });
}, 20000);

if (config.enabled) {
    startDaemon();
}
syncActivity();

service.register('keepalive', function (message) {
    if (config.enabled) {
        startDaemon(function () {
            message.respond({ returnValue: true, status: 'alive' });
        });
    } else {
        message.respond({ returnValue: true, status: 'disabled' });
    }
});

service.register('start', function (message) {
    config.enabled = true;
    saveConfig();
    startDaemon(function () {
        syncActivity();
        message.respond({
            returnValue: true,
            status: 'started',
            enabled: true,
            proxy: '127.0.0.1:1055'
        });
    });
});

service.register('toggleEnabled', function (message) {
    var newState = message.payload && typeof message.payload.enabled === 'boolean'
        ? message.payload.enabled
        : !config.enabled;

    config.enabled = newState;
    saveConfig();
    syncActivity();

    if (config.enabled) {
        startDaemon(function () {
            message.respond({ returnValue: true, enabled: true });
        });
    } else {
        stopAll();
        message.respond({ returnValue: true, enabled: false });
    }
});

service.register('toggleAutostart', function (message) {
    var newState = message.payload && typeof message.payload.autostart === 'boolean'
        ? message.payload.autostart
        : !config.autostart;

    config.autostart = newState;
    saveConfig();
    syncActivity();

    message.respond({ returnValue: true, autostart: config.autostart });
});

service.register('status', function (message) {
    var currentBin = getTailscaleBin();
    child_process.execFile(currentBin, ['version'], { timeout: 2000 }, function (vErr, vOut) {
        var vMatch = (vOut || '').match(/^([0-9\.]+)/);
        var currentVersion = vMatch ? vMatch[1] : pkgInfo.version;

        if (!config.enabled) {
            message.respond({
                returnValue: true,
                online: false,
                enabled: false,
                autostart: config.autostart,
                version: currentVersion,
                backendState: 'Stopped',
                authUrl: '',
                ips: [],
                self: {},
                proxy: '127.0.0.1:1055'
            });
            return;
        }

        startDaemon(function () {
            child_process.execFile(currentBin, ['--socket=' + socketFile, 'status', '--json'], { timeout: 4000 }, function (err, stdout, stderr) {
                if (err) {
                    child_process.execFile(currentBin, ['--socket=' + socketFile, 'status'], { timeout: 2000 }, function (err2, out2, errText) {
                        var combined = (out2 || '') + (errText || '');
                        var match = combined.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/);
                        message.respond({
                            returnValue: true,
                            online: false,
                            enabled: true,
                            autostart: config.autostart,
                            version: currentVersion,
                            authUrl: match ? match[0] : '',
                            rawStatus: combined || 'Logged out'
                        });
                    });
                    return;
                }
                try {
                    var data = JSON.parse(stdout);
                    message.respond({
                        returnValue: true,
                        online: data.BackendState === 'Running',
                        enabled: true,
                        autostart: config.autostart,
                        version: currentVersion,
                        backendState: data.BackendState,
                        authUrl: data.AuthURL || '',
                        ips: data.TailscaleIPs || [],
                        self: data.Self || {},
                        proxy: '127.0.0.1:1055'
                    });
                } catch (parseErr) {
                    message.respond({
                        returnValue: false,
                        errorText: 'Parse error: ' + parseErr.message
                    });
                }
            });
        });
    });
});

service.register('checkUpdate', function (message) {
    child_process.execFile('/usr/bin/curl', ['-sI', 'https://pkgs.tailscale.com/stable/tailscale_latest_arm.tgz'], { timeout: 8000 }, function (err, stdout) {
        if (err || !stdout) {
            message.respond({ returnValue: false, error: 'Network error checking update' });
            return;
        }
        var m = stdout.match(/Location:\s*\/stable\/tailscale_([0-9\.]+)_arm/i);
        var latestVersion = m ? m[1] : '';

        child_process.execFile(getTailscaleBin(), ['version'], { timeout: 2500 }, function (err2, out2) {
            var curM = (out2 || '').match(/^([0-9\.]+)/);
            var currentVersion = curM ? curM[1] : pkgInfo.version;
            var hasUpdate = !!(latestVersion && latestVersion !== currentVersion);
            message.respond({
                returnValue: true,
                hasUpdate: hasUpdate,
                latestVersion: latestVersion || currentVersion,
                currentVersion: currentVersion
            });
        });
    });
});

service.register('applyUpdate', function (message) {
    var tmpTgz = '/tmp/tailscale_latest.tgz';
    var tmpExtract = '/tmp/ts_extracted';

    child_process.execFile('/usr/bin/curl', ['-sL', 'https://pkgs.tailscale.com/stable/tailscale_latest_arm.tgz', '-o', tmpTgz], { timeout: 120000 }, function (err) {
        if (err) {
            message.respond({ returnValue: false, error: 'Download failed: ' + err.message });
            return;
        }

        var extractCmd = 'mkdir -p ' + tmpExtract + ' && tar -xzf ' + tmpTgz + ' -C ' + tmpExtract;
        child_process.exec(extractCmd, { timeout: 30000 }, function (err2) {
            if (err2) {
                message.respond({ returnValue: false, error: 'Extract failed: ' + err2.message });
                return;
            }

            var moveCmd = 'mkdir -p ' + customBinDir + ' && cp -f ' + tmpExtract + '/*/tailscale* ' + customBinDir + '/ && chmod 0755 ' + customBinDir + '/* && rm -rf ' + tmpExtract + ' ' + tmpTgz;
            child_process.exec(moveCmd, { timeout: 15000 }, function (err3) {
                if (err3) {
                    message.respond({ returnValue: false, error: 'Install failed: ' + err3.message });
                    return;
                }

                stopAll();
                setTimeout(function () {
                    startDaemon(function () {
                        child_process.execFile(getTailscaleBin(), ['version'], { timeout: 3000 }, function (err4, out4) {
                            var curM = (out4 || '').match(/^([0-9\.]+)/);
                            var newVer = curM ? curM[1] : 'updated';
                            message.respond({
                                returnValue: true,
                                success: true,
                                version: newVer
                            });
                        });
                    });
                }, 1000);
            });
        });
    });
});

service.register('up', function (message) {
    if (!config.enabled) {
        config.enabled = true;
        saveConfig();
    }

    startDaemon(function () {
        var args = ['--socket=' + socketFile, 'up', '--reset', '--timeout=5s'];
        var authKey = message.payload ? message.payload.authKey : null;
        if (authKey) {
            args.push('--auth-key=' + authKey);
        }

        child_process.execFile(getTailscaleBin(), args, { timeout: 8000 }, function (err, stdout, stderr) {
            var combined = (stdout || '') + (stderr || '');
            var authUrl = '';
            var match = combined.match(/https:\/\/login\.tailscale\.com\/a\/[a-zA-Z0-9]+/);
            if (match) {
                authUrl = match[0];
            }

            message.respond({
                returnValue: true,
                authUrl: authUrl,
                output: combined
            });
        });
    });
});

service.register('down', function (message) {
    child_process.execFile(getTailscaleBin(), ['--socket=' + socketFile, 'down'], { timeout: 4000 }, function (err, stdout, stderr) {
        message.respond({
            returnValue: !err,
            output: stdout || stderr
        });
    });
});

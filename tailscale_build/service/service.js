process.env.NODE_PATH = '/usr/palm/frameworks:/usr/lib/nodejs:/usr/lib/node_modules:' + (process.env.NODE_PATH || '');
try { require('module').Module._initPaths(); } catch (e) {}

var Service = require('webos-service');
var pkgInfo = require('./package.json');
var child_process = require('child_process');
var fs = require('fs');
var path = require('path');
var http = require('http');

var service = null;
try {
    var Service = require('webos-service');
    service = new Service(pkgInfo.name);
} catch (e) {
    console.warn('Luna bus service registration notice:', e.message);
}

var baseDir = __dirname;
var defaultBinDir = path.join(baseDir, 'bin');
var customBinDir = '/media/developer/temp/tailscale_bin';

var stateDir = '/tmp';
var stateFile = '/tmp/tailscaled.state';
var configFile = '/media/developer/temp/tailscale_config.json';
var socketFile = '/tmp/tailscaled.sock';

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

function stopAll(cb) {
    child_process.execFile(getTailscaleBin(), ['--socket=' + socketFile, 'down'], { timeout: 4000 }, function () {
        if (cb) cb();
    });
}

function startDaemon(cb) {
    if (!config.enabled) {
        if (cb) cb();
        return;
    }

    var tailscaleBin = getTailscaleBin();
    var tailscaledBin = getTailscaledBin();

    child_process.execFile(tailscaleBin, ['--socket=' + socketFile, 'status'], { timeout: 2000 }, function (err, stdout, stderr) {
        if (!err || (stdout && stdout.indexOf('Logged out') !== -1)) {
            child_process.execFile(tailscaleBin, ['--socket=' + socketFile, 'up', '--reset'], { timeout: 5000 }, function () {
                if (cb) cb();
            });
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
            child_process.execFile(tailscaleBin, ['--socket=' + socketFile, 'up', '--reset'], { timeout: 5000 }, function () {
                if (cb) cb();
            });
        }, 1200);
    });
}

function syncActivity() {
    if (!service) return;
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
                callback: { method: 'luna://' + pkgInfo.name + '/keepalive', params: {} }
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

// Core logic handlers (shared between Luna bus and direct HTTP API)
function handleStatus(cb) {
    var currentBin = getTailscaleBin();
    child_process.execFile(currentBin, ['version'], { timeout: 2000 }, function (vErr, vOut) {
        var vMatch = (vOut || '').match(/^([0-9\.]+)/);
        var currentVersion = vMatch ? vMatch[1] : pkgInfo.version;

        if (!config.enabled) {
            cb({
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
                        cb({
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
                    cb({
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
                    cb({
                        returnValue: false,
                        errorText: 'Parse error: ' + parseErr.message
                    });
                }
            });
        });
    });
}

function handleToggleEnabled(params, cb) {
    var newState = params && typeof params.enabled === 'boolean'
        ? params.enabled
        : !config.enabled;

    config.enabled = newState;
    saveConfig();
    syncActivity();

    if (config.enabled) {
        startDaemon(function () {
            cb({ returnValue: true, enabled: true });
        });
    } else {
        stopAll(function () {
            cb({ returnValue: true, enabled: false });
        });
    }
}

function handleToggleAutostart(params, cb) {
    var newState = params && typeof params.autostart === 'boolean'
        ? params.autostart
        : !config.autostart;

    config.autostart = newState;
    saveConfig();
    syncActivity();

    cb({ returnValue: true, autostart: config.autostart });
}

function handleUp(params, cb) {
    if (!config.enabled) {
        config.enabled = true;
        saveConfig();
    }

    startDaemon(function () {
        var args = ['--socket=' + socketFile, 'up', '--reset', '--timeout=5s'];
        var authKey = params ? params.authKey : null;
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

            cb({
                returnValue: true,
                authUrl: authUrl,
                output: combined
            });
        });
    });
}

function handleDown(params, cb) {
    child_process.execFile(getTailscaleBin(), ['--socket=' + socketFile, 'down'], { timeout: 4000 }, function (err, stdout, stderr) {
        cb({
            returnValue: !err,
            output: stdout || stderr
        });
    });
}

function handleCheckUpdate(params, cb) {
    child_process.execFile('/usr/bin/curl', ['-sI', 'https://pkgs.tailscale.com/stable/tailscale_latest_arm.tgz'], { timeout: 8000 }, function (err, stdout) {
        if (err || !stdout) {
            cb({ returnValue: false, error: 'Network error checking update' });
            return;
        }
        var m = stdout.match(/Location:\s*\/stable\/tailscale_([0-9\.]+)_arm/i);
        var latestVersion = m ? m[1] : '';

        child_process.execFile(getTailscaleBin(), ['version'], { timeout: 2500 }, function (err2, out2) {
            var curM = (out2 || '').match(/^([0-9\.]+)/);
            var currentVersion = curM ? curM[1] : pkgInfo.version;
            var hasUpdate = !!(latestVersion && latestVersion !== currentVersion);

            cb({
                returnValue: true,
                hasUpdate: hasUpdate,
                latestVersion: latestVersion || currentVersion,
                currentVersion: currentVersion
            });
        });
    });
}

function handleApplyUpdate(params, cb) {
    var tmpTgz = '/tmp/tailscale_latest.tgz';
    var tmpExtract = '/tmp/ts_extracted';

    child_process.execFile('/usr/bin/curl', ['-sL', 'https://pkgs.tailscale.com/stable/tailscale_latest_arm.tgz', '-o', tmpTgz], { timeout: 120000 }, function (err) {
        if (err) {
            cb({ returnValue: false, error: 'Download failed: ' + err.message });
            return;
        }

        var extractCmd = 'mkdir -p ' + tmpExtract + ' && tar -xzf ' + tmpTgz + ' -C ' + tmpExtract;
        child_process.exec(extractCmd, { timeout: 30000 }, function (err2) {
            if (err2) {
                cb({ returnValue: false, error: 'Extract failed: ' + err2.message });
                return;
            }

            var moveCmd = 'mkdir -p ' + customBinDir + ' && cp -f ' + tmpExtract + '/*/tailscale* ' + customBinDir + '/ && chmod 0755 ' + customBinDir + '/* && rm -rf ' + tmpExtract + ' ' + tmpTgz;
            child_process.exec(moveCmd, { timeout: 15000 }, function (err3) {
                if (err3) {
                    cb({ returnValue: false, error: 'Install failed: ' + err3.message });
                    return;
                }

                stopAll();
                setTimeout(function () {
                    startDaemon(function () {
                        child_process.execFile(getTailscaleBin(), ['version'], { timeout: 3000 }, function (err4, out4) {
                            var curM = (out4 || '').match(/^([0-9\.]+)/);
                            var newVer = curM ? curM[1] : 'updated';
                            cb({
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
}

// 1. Register Luna Bus methods (if available)
if (service) {
    service.register('status', function (message) {
        handleStatus(function (res) { message.respond(res); });
    });
    service.register('toggleEnabled', function (message) {
        handleToggleEnabled(message.payload, function (res) { message.respond(res); });
    });
    service.register('toggleAutostart', function (message) {
        handleToggleAutostart(message.payload, function (res) { message.respond(res); });
    });
    service.register('up', function (message) {
        handleUp(message.payload, function (res) { message.respond(res); });
    });
    service.register('down', function (message) {
        handleDown(message.payload, function (res) { message.respond(res); });
    });
    service.register('checkUpdate', function (message) {
        handleCheckUpdate(message.payload, function (res) { message.respond(res); });
    });
    service.register('applyUpdate', function (message) {
        handleApplyUpdate(message.payload, function (res) { message.respond(res); });
    });
    service.register('keepalive', function (message) {
        if (config.enabled) {
            startDaemon(function () { message.respond({ returnValue: true, status: 'alive' }); });
        } else {
            message.respond({ returnValue: true, status: 'disabled' });
        }
    });
}

// 2. Start direct high-speed HTTP API fallback (127.0.0.1:1056)
try {
    var httpServer = http.createServer(function (req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        var urlParts = (req.url || '').split('?');
        var endpoint = urlParts[0].replace(/^\//, '');

        var body = '';
        req.on('data', function (chunk) { body += chunk; });
        req.on('end', function () {
            var params = {};
            try { if (body) params = JSON.parse(body); } catch (e) {}

            function sendJson(data) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            }

            if (endpoint === 'status') handleStatus(sendJson);
            else if (endpoint === 'toggleEnabled') handleToggleEnabled(params, sendJson);
            else if (endpoint === 'toggleAutostart') handleToggleAutostart(params, sendJson);
            else if (endpoint === 'up') handleUp(params, sendJson);
            else if (endpoint === 'down') handleDown(params, sendJson);
            else if (endpoint === 'checkUpdate') handleCheckUpdate(params, sendJson);
            else if (endpoint === 'applyUpdate') handleApplyUpdate(params, sendJson);
            else sendJson({ returnValue: false, error: 'Endpoint not found' });
        });
    });

    httpServer.listen(1056, '127.0.0.1', function () {
        console.log('Direct local API running on http://127.0.0.1:1056');
    });
} catch (httpErr) {
    console.error('Failed to bind HTTP fallback API:', httpErr);
}

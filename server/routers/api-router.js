let express = require("express");
const {
    setting,
    allowDevAllOrigin,
    allowAllOrigin,
    percentageToColor,
    filterAndJoin,
    sendHttpError,
} = require("../util-server");
const { R } = require("redbean-node");
const apicache = require("../modules/apicache");
const Monitor = require("../model/monitor");
const dayjs = require("dayjs");
const { UP, MAINTENANCE, DOWN, PENDING, flipStatus, log, badgeConstants } = require("../../src/util");
const StatusPage = require("../model/status_page");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { UptimeCacheList } = require("../uptime-cache-list");
const { makeBadge } = require("badge-maker");
const { Prometheus } = require("../prometheus");

let router = express.Router();

let cache = apicache.middleware;
const server = UptimeKumaServer.getInstance();
let io = server.io;

router.get("/api/entry-page", async (request, response) => {
    allowDevAllOrigin(response);

    let result = { };
    let hostname = request.hostname;
    if ((await setting("trustProxy")) && request.headers["x-forwarded-host"]) {
        hostname = request.headers["x-forwarded-host"];
    }

    if (hostname in StatusPage.domainMappingList) {
        result.type = "statusPageMatchedDomain";
        result.statusPageSlug = StatusPage.domainMappingList[hostname];
    } else {
        result.type = "entryPage";
        result.entryPage = server.entryPage;
    }
    response.json(result);
});

router.get("/api/push/:pushToken", async (request, response) => {
    try {

        let pushToken = request.params.pushToken;
        let msg = request.query.msg || "OK";
        let ping = parseFloat(request.query.ping) || null;
        let statusString = request.query.status || "up";
        let status = (statusString === "up") ? UP : DOWN;

        let monitor = await R.findOne("monitor", " push_token = ? AND active = 1 ", [
            pushToken
        ]);

        if (! monitor) {
            throw new Error("Monitor not found or not active.");
        }

        const previousHeartbeat = await Monitor.getPreviousHeartbeat(monitor.id);

        if (monitor.isUpsideDown()) {
            status = flipStatus(status);
        }

        let isFirstBeat = true;
        let previousStatus = status;
        let duration = 0;

        let bean = R.dispense("heartbeat");
        bean.time = R.isoDateTimeMillis(dayjs.utc());

        if (previousHeartbeat) {
            isFirstBeat = false;
            previousStatus = previousHeartbeat.status;
            duration = dayjs(bean.time).diff(dayjs(previousHeartbeat.time), "second");
        }

        if (await Monitor.isUnderMaintenance(monitor.id)) {
            msg = "Monitor under maintenance";
            status = MAINTENANCE;
        }

        log.debug("router", `/api/push/ called at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`);
        log.debug("router", "PreviousStatus: " + previousStatus);
        log.debug("router", "Current Status: " + status);

        bean.important = Monitor.isImportantBeat(isFirstBeat, previousStatus, status);
        bean.monitor_id = monitor.id;
        bean.status = status;
        bean.msg = msg;
        bean.ping = ping;
        bean.duration = duration;

        await R.store(bean);

        io.to(monitor.user_id).emit("heartbeat", bean.toJSON());
        UptimeCacheList.clearCache(monitor.id);
        Monitor.sendStats(io, monitor.id, monitor.user_id);
        new Prometheus(monitor).update(bean, undefined);

        response.json({
            ok: true,
        });

        if (Monitor.isImportantForNotification(isFirstBeat, previousStatus, status)) {
            await Monitor.sendNotification(isFirstBeat, monitor, bean);
        }

    } catch (e) {
        response.status(404).json({
            ok: false,
            msg: e.message
        });
    }
});

router.get("/api/badge/:id/status", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        upLabel = "Up",
        downLabel = "Down",
        pendingLabel = "Pending",
        maintenanceLabel = "Maintenance",
        upColor = badgeConstants.defaultUpColor,
        downColor = badgeConstants.defaultDownColor,
        pendingColor = badgeConstants.defaultPendingColor,
        maintenanceColor = badgeConstants.defaultMaintenanceColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        const overrideValue = value !== undefined ? parseInt(value) : undefined;

        let publicMonitor = await R.getRow(`
                SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
                WHERE monitor_group.group_id = \`group\`.id
                AND monitor_group.monitor_id = ?
                AND public = 1
            `,
        [ requestedMonitorId ]
        );

        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await Monitor.getPreviousHeartbeat(requestedMonitorId);
            const state = overrideValue !== undefined ? overrideValue : heartbeat.status;

            if (label === undefined) {
                badgeValues.label = "Status";
            } else {
                badgeValues.label = label;
            }
            switch (state) {
                case DOWN:
                    badgeValues.color = downColor;
                    badgeValues.message = downLabel;
                    break;
                case UP:
                    badgeValues.color = upColor;
                    badgeValues.message = upLabel;
                    break;
                case PENDING:
                    badgeValues.color = pendingColor;
                    badgeValues.message = pendingLabel;
                    break;
                case MAINTENANCE:
                    badgeValues.color = maintenanceColor;
                    badgeValues.message = maintenanceLabel;
                    break;
                default:
                    badgeValues.color = badgeConstants.naColor;
                    badgeValues.message = "N/A";
            }
        }

        // build the svg based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/uptime/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultUptimeLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultUptimeValueSuffix,
        color,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);
        // if no duration is given, set value to 24 (h)
        const requestedDuration = request.params.duration !== undefined ? parseInt(request.params.duration, 10) : 24;
        const overrideValue = value && parseFloat(value);

        let publicMonitor = await R.getRow(`
                SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
                WHERE monitor_group.group_id = \`group\`.id
                AND monitor_group.monitor_id = ?
                AND public = 1
            `,
        [ requestedMonitorId ]
        );

        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent
            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const uptime = overrideValue ?? await Monitor.calcUptime(
                requestedDuration,
                requestedMonitorId
            );

            // limit the displayed uptime percentage to four (two, when displayed as percent) decimal digits
            const cleanUptime = (uptime * 100).toPrecision(4);

            // use a given, custom color or calculate one based on the uptime value
            badgeValues.color = color ?? percentageToColor(uptime);
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a label string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Uptime (${requestedDuration}${labelSuffix})`,
            ]);
            badgeValues.message = filterAndJoin([ prefix, cleanUptime, suffix ]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/ping/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix = badgeConstants.defaultPingLabelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);

        // Default duration is 24 (h) if not defined in queryParam, limited to 720h (30d)
        const requestedDuration = Math.min(request.params.duration ? parseInt(request.params.duration, 10) : 24, 720);
        const overrideValue = value && parseFloat(value);

        const publicAvgPing = parseInt(await R.getCell(`
                SELECT AVG(ping) FROM monitor_group, \`group\`, heartbeat
                WHERE monitor_group.group_id = \`group\`.id
                AND heartbeat.time > DATETIME('now', ? || ' hours')
                AND heartbeat.ping IS NOT NULL
                AND public = 1
                AND heartbeat.monitor_id = ?
            `,
        [ -requestedDuration, requestedMonitorId ]
        ));

        const badgeValues = { style };

        if (!publicAvgPing) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non exsitant

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPing = parseInt(overrideValue ?? publicAvgPing);

            badgeValues.color = color;
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a lable string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([ labelPrefix, label ?? `Avg. Ping (${requestedDuration}${labelSuffix})` ]);
            badgeValues.message = filterAndJoin([ prefix, avgPing, suffix ]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/avg-response/:duration?", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);

        // Default duration is 24 (h) if not defined in queryParam, limited to 720h (30d)
        const requestedDuration = Math.min(
            request.params.duration
                ? parseInt(request.params.duration, 10)
                : 24,
            720
        );
        const overrideValue = value && parseFloat(value);

        const publicAvgPing = parseInt(await R.getCell(`
            SELECT AVG(ping) FROM monitor_group, \`group\`, heartbeat
            WHERE monitor_group.group_id = \`group\`.id
            AND heartbeat.time > DATETIME('now', ? || ' hours')
            AND heartbeat.ping IS NOT NULL
            AND public = 1
            AND heartbeat.monitor_id = ?
            `,
        [ -requestedDuration, requestedMonitorId ]
        ));

        const badgeValues = { style };

        if (!publicAvgPing) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const avgPing = parseInt(overrideValue ?? publicAvgPing);

            badgeValues.color = color;
            // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
            badgeValues.labelColor = labelColor ?? "";
            // build a label string. If a custom label is given, override the default one (requestedDuration)
            badgeValues.label = filterAndJoin([
                labelPrefix,
                label ?? `Avg. Response (${requestedDuration}h)`,
                labelSuffix,
            ]);
            badgeValues.message = filterAndJoin([ prefix, avgPing, suffix ]);
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/cert-exp", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const date = request.query.date;

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = date ? "" : badgeConstants.defaultCertExpValueSuffix,
        upColor = badgeConstants.defaultUpColor,
        warnColor = badgeConstants.defaultWarnColor,
        downColor = badgeConstants.defaultDownColor,
        warnDays = badgeConstants.defaultCertExpireWarnDays,
        downDays = badgeConstants.defaultCertExpireDownDays,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);

        const overrideValue = value && parseFloat(value);

        let publicMonitor = await R.getRow(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND monitor_group.monitor_id = ?
            AND public = 1
            `,
        [ requestedMonitorId ]
        );

        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [
                requestedMonitorId,
            ]);

            if (!tlsInfoBean) {
                // return a "No/Bad Cert" badge in naColor (grey), if no cert saved (does not save bad certs?)
                badgeValues.message = "No/Bad Cert";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const tlsInfo = JSON.parse(tlsInfoBean.info_json);

                if (!tlsInfo.valid) {
                    // return a "Bad Cert" badge in naColor (grey), when cert is not valid
                    badgeValues.message = "Bad Cert";
                    badgeValues.color = downColor;
                } else {
                    const daysRemaining = parseInt(overrideValue ?? tlsInfo.certInfo.daysRemaining);

                    if (daysRemaining > warnDays) {
                        badgeValues.color = upColor;
                    } else if (daysRemaining > downDays) {
                        badgeValues.color = warnColor;
                    } else {
                        badgeValues.color = downColor;
                    }
                    // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
                    badgeValues.labelColor = labelColor ?? "";
                    // build a label string. If a custom label is given, override the default one
                    badgeValues.label = filterAndJoin([
                        labelPrefix,
                        label ?? "Cert Exp.",
                        labelSuffix,
                    ]);
                    badgeValues.message = filterAndJoin([ prefix, date ? tlsInfo.certInfo.validTo : daysRemaining, suffix ]);
                }
            }
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/badge/:id/response", cache("5 minutes"), async (request, response) => {
    allowAllOrigin(response);

    const {
        label,
        labelPrefix,
        labelSuffix,
        prefix,
        suffix = badgeConstants.defaultPingValueSuffix,
        color = badgeConstants.defaultPingColor,
        labelColor,
        style = badgeConstants.defaultStyle,
        value, // for demo purpose only
    } = request.query;

    try {
        const requestedMonitorId = parseInt(request.params.id, 10);

        const overrideValue = value && parseFloat(value);

        let publicMonitor = await R.getRow(`
            SELECT monitor_group.monitor_id FROM monitor_group, \`group\`
            WHERE monitor_group.group_id = \`group\`.id
            AND monitor_group.monitor_id = ?
            AND public = 1
            `,
        [ requestedMonitorId ]
        );

        const badgeValues = { style };

        if (!publicMonitor) {
            // return a "N/A" badge in naColor (grey), if monitor is not public / not available / non existent

            badgeValues.message = "N/A";
            badgeValues.color = badgeConstants.naColor;
        } else {
            const heartbeat = await Monitor.getPreviousHeartbeat(
                requestedMonitorId
            );

            if (!heartbeat.ping) {
                // return a "N/A" badge in naColor (grey), if previous heartbeat has no ping

                badgeValues.message = "N/A";
                badgeValues.color = badgeConstants.naColor;
            } else {
                const ping = parseInt(overrideValue ?? heartbeat.ping);

                badgeValues.color = color;
                // use a given, custom labelColor or use the default badge label color (defined by badge-maker)
                badgeValues.labelColor = labelColor ?? "";
                // build a label string. If a custom label is given, override the default one
                badgeValues.label = filterAndJoin([
                    labelPrefix,
                    label ?? "Response",
                    labelSuffix,
                ]);
                badgeValues.message = filterAndJoin([ prefix, ping, suffix ]);
            }
        }

        // build the SVG based on given values
        const svg = makeBadge(badgeValues);

        response.type("image/svg+xml");
        response.send(svg);
    } catch (error) {
        sendHttpError(response, error.message);
    }
});

router.get("/api/hello", (req, res) => {
    res.json({ message: "Hello from new endpoint!" });
});

// Endpoint: GET /api/down-monitor
// Description: Returns a list of APIs (monitors) that are currently down.
// The response includes the monitor name, URL, last message, and last checked time.

router.get("/api/down-monitor", async (req, res) => {
    try {
        // Query the latest heartbeat for each monitor and select those with status = 0 (down)
        const rows = await R.getAll(`
            SELECT m.name, m.url, h.status, h.msg, h.time
            FROM monitor m
            JOIN (
                SELECT monitor_id, MAX(time) AS last_time
                FROM heartbeat
                GROUP BY monitor_id
            ) latest ON m.id = latest.monitor_id
            JOIN heartbeat h ON h.monitor_id = latest.monitor_id AND h.time = latest.last_time
            WHERE h.status = 0
        `);

        // Respond with a JSON object containing the list of down APIs
        res.json({
            downApis: rows.map(row => ({
                name: row.name, // Monitor name
                url: row.url,   // Monitor URL
                message: row.msg, // Last message from heartbeat
                lastChecked: new Date(row.time).toISOString() // Last checked time in ISO format
            }))
        });
    } catch (e) {
        // Handle errors and respond with status 500 and error message
        res.status(500).json({
            ok: false,
            msg: e.message
        });
    }

    // Endpoint: GET /api/up-monitor
    // Description: Returns a list of monitors that are currently up.
    // The response includes the monitor name, URL, last message, and last checked time.

    router.get("/api/up-monitor", async (req, res) => {
        try {
            // Query the latest heartbeat for each monitor and select those with status = 1 (up)
            const rows = await R.getAll(`
            SELECT m.name, m.url, h.status, h.msg, h.time
            FROM monitor m
            JOIN (
                SELECT monitor_id, MAX(time) AS last_time
                FROM heartbeat
                GROUP BY monitor_id
            ) latest ON m.id = latest.monitor_id
            JOIN heartbeat h ON h.monitor_id = latest.monitor_id AND h.time = latest.last_time
            WHERE h.status = 1
        `);

            // Respond with a JSON object containing the list of up monitors
            res.json({
                upMonitors: rows.map(row => ({
                    name: row.name, // Monitor name
                    url: row.url,   // Monitor URL
                    message: row.msg, // Last message from heartbeat
                    lastChecked: new Date(row.time).toISOString() // Last checked time in ISO format
                }))
            });
        } catch (e) {
        // Handle errors and respond with status 500 and error message
            res.status(500).json({
                ok: false,
                msg: e.message
            });
        }

    });
});

router.get("/status-tawk", async (req, res) => {
    try {
        const rows = await R.getAll(`
            SELECT
                m.name,
                m.url,
                MIN(h.time) AS down_since,
                MAX(h.time) AS last_checked,
                MAX(h.status) AS status,
                h.msg
            FROM monitor m
            JOIN heartbeat h ON m.id = h.monitor_id
            WHERE h.status = 0
              AND h.time >= (
                SELECT MAX(time)
                FROM heartbeat
                WHERE monitor_id = m.id AND status = 1
            )
            GROUP BY m.id
        `);

        const downApis = rows.map(row => {
            const downSince = new Date(row.down_since);
            const lastChecked = new Date(row.last_checked);
            const durationMs = lastChecked - downSince;
            const durationMinutes = Math.floor(durationMs / 60000);
            const durationHours = Math.floor(durationMinutes / 60);
            const remainingMinutes = durationMinutes % 60;

            const durationText = durationMinutes >= 60
                ? `${durationHours} jam ${remainingMinutes} menit`
                : `${durationMinutes} menit`;

            console.log(row, "row");

            return {
                name: row.name,
                url: row.url,
                message: row.msg,
                status: row.status,
                lastChecked: lastChecked.toLocaleString("id-ID", {
                    dateStyle: "long",
                    timeStyle: "short",
                    timeZone: "Asia/Jakarta"
                }),
                durationText
            };
        });

        let html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Status Layanan Waspada AI</title>
                <meta charset="UTF-8" />
                <style>
                    body { font-family: sans-serif; padding: 20px; }
                    h1 { color: #c0392b; }
                    ul { padding-left: 20px; }
                    li { margin-bottom: 10px; }
                    a { color: #2980b9; }
                </style>
            </head>
            <body>
                <h1>Status Layanan Waspada AI</h1>
        `;

        if (downApis.length === 0) {
            html += "<p>✅ Semua sistem saat ini berjalan normal.</p>";
        } else {
            html += "<p>⚠️ Beberapa layanan sedang bermasalah:</p><ul>";
            for (const api of downApis) {
                html += `<li>
                    <strong>${api.name}</strong><br/>
                    URL: <a href="${api.url}" target="_blank">${api.url}</a><br/>
                    Pesan: ${api.message}<br/>
                    Terakhir dicek: ${api.lastChecked}<br/>
                    Durasi down: ${api.durationText}
                </li>`;
            }
            html += "</ul>";
        }

        html += `
            </body>
            </html>
        `;

        res.setHeader("Content-Type", "text/html");
        res.send(html);
    } catch (e) {
        res.status(500).send(`<p>Gagal mengambil status layanan: ${e.message}</p>`);
    }

});

module.exports = router;

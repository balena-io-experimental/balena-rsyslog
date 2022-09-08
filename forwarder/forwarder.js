const https = require('https');
const _ = require('lodash');
const stream = require('stream');
const url = require('url');
const zlib = require('zlib');

const ZLIB_TIMEOUT = 100;
const MIN_COOLDOWN_PERIOD = 5 * 1000; // 5 seconds
const MAX_COOLDOWN_PERIOD = 300 * 1000; // 5 minutes
const KEEPALIVE_TIMEOUT = 60 * 1000;
const RESPONSE_GRACE_PERIOD = 5 * 1000;

const MAX_LOG_LENGTH = 10 * 1000;
const MAX_PENDING_BYTES = 256 * 1024;

const fs = require('fs');

const debugStream = fs.createWriteStream('/usr/src/app/logs/debug.log');

// This is copy-pasted from the current Supervisor source code for log streaming.
// In production, it can be replaced by a more minimal binary, written in Rust or Go.
class BalenaLogForwarder {
    constructor({ apiEndpoint, uuid, deviceApiKey }) {
        this.initialized = false;
		this.publishEnabled = true;
		this.unmanaged = false;

		// TODO:
		this.writable = true;

		if (uuid && deviceApiKey) {
			this.assignFields({ apiEndpoint, uuid, deviceApiKey });
		}
        
        // This stream serves serves as a message buffer during reconnections
		// while we unpipe the old, malfunctioning connection and then repipe a
		// new one.
		this.stream = new stream.PassThrough({
			allowHalfOpen: true,

			// We halve the high watermark because a passthrough stream has two
			// buffers, one for the writable and one for the readable side. The
			// write() call only returns false when both buffers are full.
			highWaterMark: MAX_PENDING_BYTES / 2,
		});

		this.stream.on('drain', () => {
			this.writable = true;
			this.flush();
			if (this.dropCount > 0) {
				this.write({
					message: `Warning: Suppressed ${this.dropCount} message(s) due to high load`,
					timestamp: Date.now(),
					isSystem: true,
					isStdErr: true,
				});
				this.dropCount = 0;
			}
		});

        // Setup options
        this.lastSetupAttempt = 0;
	    this.setupFailures = 0;
	    this.setupPending = false;
    }

    isInitialized() {
        return this.initialized;
    }
    
    assignFields({ apiEndpoint, uuid, deviceApiKey }) {
		this.opts = url.parse(`${apiEndpoint}/device/v2/${uuid}/log-stream`);
		this.opts.method = 'POST';
		this.opts.headers = {
			Authorization: `Bearer ${deviceApiKey}`,
			'Content-Type': 'application/x-ndjson',
			'Content-Encoding': 'gzip',
		};

		this.initialized = true;
	}

    log(messageJson) {
        // TODO: Perhaps don't just drop logs when we haven't
		// yet initialised (this happens when a device has not yet
		// been provisioned)
        if (this.unmanaged || !this.publishEnabled || !this.initialized) {
			return;
		}

        if (!_.isObject(messageJson)) {
			messageJson = JSON.parse(messageJson);
		}

        // Messages for services should have serviceId and imageId fields
        // if (!messageJson.isSystem && messageJson.serviceId == null) {
		// 	return;
		// }

        messageJson.message = _.truncate(messageJson.message, {
			length: MAX_LOG_LENGTH,
			omission: '[...]',
		});

        this.write(messageJson);
    }

    setup() {
        if (this.setupPending || this.req != null) {
			// If we already have a setup pending, or we are already setup, then do nothing
			return;
		}
		this.setupPending = true;

		// Work out the total delay we need
		const totalDelay = Math.min(
			2 ** this.setupFailures * MIN_COOLDOWN_PERIOD,
			MAX_COOLDOWN_PERIOD,
		);
		// Work out how much of a delay has already occurred since the last attempt
		const alreadyDelayedBy = Date.now() - this.lastSetupAttempt;
		// The difference between the two is the actual delay we want
		const delay = Math.max(totalDelay - alreadyDelayedBy, 0);

        setTimeout(() => {
			this.setupPending = false;
			this.lastSetupAttempt = Date.now();

			const setupFailed = () => {
				this.setupFailures++;
				this.teardown();
			};

			this.req = https.request(this.opts);

			// Since we haven't sent the request body yet, and never will,the
			// only reason for the server to prematurely respond is to
			// communicate an error. So teardown the connection immediately
			this.req.on('response', (res) => {
				console.error(
					'LogBackend: server responded with status code:',
					res.statusCode,
				);
				setupFailed();
			});

			this.req.on('timeout', setupFailed);
			this.req.on('close', setupFailed);
			this.req.on('error', (err) => {
				console.error('LogBackend: unexpected error:', err);
				setupFailed();
			});

			// Immediately flush the headers. This gives a chance to the server to
			// respond with potential errors such as 401 authentication error
			this.req.flushHeaders();

			// We want a very low writable high watermark to prevent having many
			// chunks stored in the writable queue of @_gzip and have them in
			// @_stream instead. This is desirable because once @_gzip.flush() is
			// called it will do all pending writes with that flush flag. This is
			// not what we want though. If there are 100 items in the queue we want
			// to write all of them with Z_NO_FLUSH and only afterwards do a
			// Z_SYNC_FLUSH to maximize compression
			this.gzip = zlib.createGzip({ writableHighWaterMark: 1024 });
			this.gzip.on('error', setupFailed);
			this.gzip.pipe(this.req);

			// Only start piping if there has been no error after the header flush.
			// Doing it immediately would potentially lose logs if it turned out that
			// the server is unavailalbe because @_req stream would consume our
			// passthrough buffer
			this.timeout = setTimeout(() => {
				if (this.gzip != null) {
					this.setupFailures = 0;
					this.stream.pipe(this.gzip);
					setImmediate(this.flush);
				}
			}, RESPONSE_GRACE_PERIOD);
		}, delay);
    }

    snooze = _.debounce(this.teardown, KEEPALIVE_TIMEOUT);

    // Flushing every ZLIB_TIMEOUT hits a balance between compression and
	// latency. When ZLIB_TIMEOUT is 0 the compression ratio is around 5x
	// whereas when ZLIB_TIMEOUT is infinity the compession ratio is around 10x.
	flush = _.throttle(
		() => {
			if (this.gzip != null) {
				this.gzip.flush(zlib.Z_SYNC_FLUSH);
			}
		},
		ZLIB_TIMEOUT,
		{ leading: false },
	);

    teardown() {
		if (this.req != null) {
			clearTimeout(this.timeout);
			this.req.removeAllListeners();
			this.req.on('error', _.noop);
			if (this.gzip != null) {
				this.stream.unpipe(this.gzip);
				this.gzip.end();
			}
			this.req = null;
		}
	}

    write(messageJson) {
		this.snooze();
		this.setup();

		if (this.writable) {
			try {
				this.stream.write(JSON.stringify(messageJson) + '\n');
				this.flush();
				debugStream.write(`${messageJson.timestamp}: Wrote ${messageJson.message}\n`);
			} catch (err) {
				debugStream.write(`${messageJson.timestamp}: Error writing: ${err}`);
			}	
			
		} else {
			debugStream.write(`${messageJson.timestamp}: Not writeable\n`);
			this.dropCount += 1;
		}
	}

}

exports.BalenaLogForwarder = BalenaLogForwarder;

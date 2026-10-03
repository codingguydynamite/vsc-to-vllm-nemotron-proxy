'use strict';

const http = require('node:http');

//
// Configuration
//

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 30001);

const VLLM_URL =
    process.env.VLLM_URL ||
    'http://192.168.1.19:8000';

const VLLM_MODEL =
    process.env.VLLM_MODEL ||
    'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4';

//
// The only two model aliases we expose.
//
// Both aliases point to the SAME vLLM model.
// The only difference is enable_thinking.
//

const MODELS = {
    'nemotron-thinking': {
        name: 'Nemotron 3.5 Lightning - Thinking',
        enable_thinking: true
    },

    'nemotron-execution': {
        name: 'Nemotron 3.5 Lightning - Execution',
        enable_thinking: false
    }
};


//
// Read JSON request body
//

function readJsonBody(req) {
    console.log("Here")
    return new Promise((resolve, reject) => {
        let body = '';

        req.setEncoding('utf8');

        req.on('data', chunk => {
            body += chunk;
        });

        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });

        req.on('error', reject);
    });
}


//
// Send JSON response
//

function sendJson(res, statusCode, data) {
    const body = JSON.stringify(data);

    res.writeHead(statusCode, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
    });

    res.end(body);
}


//
// /health
//

function handleHealth(res) {
    sendJson(res, 200, {
        status: 'ok',
        vllm: VLLM_URL,
        model: VLLM_MODEL
    });
}


//
// /v1/models
//
// VS Code can use this to discover the two logical models.
//

function handleModels(res) {
    console.log('[request] /v1/models');
    const data = Object.entries(MODELS).map(([id, config]) => ({
        id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nvidia',
        name: config.name
    }));

    sendJson(res, 200, {
        object: 'list',
        data
    });
}


//
// /v1/chat/completions
//

async function handleChatCompletions(req, res) {
    let body;

    try {
        body = await readJsonBody(req);
        console.log('[request body]', body);
    } catch (error) {
        sendJson(res, 400, {
            error: {
                message: error.message,
                type: 'invalid_request_error'
            }
        });

        return;
    }

    //
    // VS Code sends one of:
    //
    //   nemotron-thinking
    //   nemotron-execution
    //

    const requestedModel = body.model;

    const modelConfig = MODELS[requestedModel];

    if (!modelConfig) {
        sendJson(res, 400, {
            error: {
                message:
                    `Unknown model "${requestedModel}". ` +
                    `Available models: ${Object.keys(MODELS).join(', ')}`,
                type: 'invalid_request_error'
            }
        });

        return;
    }

    //
    // Create the request sent to vLLM.
    //
    // Everything from VS Code is preserved.
    //
    // We ONLY override:
    //
    //   model
    //   chat_template_kwargs
    //

    const upstreamBody = {
        ...body,

        //
        // Replace our friendly alias with the real vLLM model.
        //
        model: VLLM_MODEL,

        //
        // Nemotron-specific configuration.
        //
        chat_template_kwargs: {
            enable_thinking: modelConfig.enable_thinking,

            force_nonempty_content: true
        }
    };

    //
    // We don't want VS Code to accidentally send
    // another chat_template_kwargs object and override ours.
    //
    // The object above already replaces it.
    //

    console.log(
        `[request] ${requestedModel} -> ${VLLM_MODEL} ` +
        `(thinking=${modelConfig.enable_thinking})`
    );

    //
    // Forward request to vLLM.
    //

    let upstreamResponse;

    try {
        upstreamResponse = await fetch(
            `${VLLM_URL}/v1/chat/completions`,
            {
                method: 'POST',

                headers: {
                    'content-type': 'application/json'
                },

                body: JSON.stringify(upstreamBody)
            }
        );
    } catch (error) {
        console.error('[vllm error]', error);

        sendJson(res, 502, {
            error: {
                message: 'Could not connect to vLLM',
                type: 'upstream_error'
            }
        });

        return;
    }

    //
    // Copy vLLM HTTP status.
    //

    res.statusCode = upstreamResponse.status;

    //
    // Copy content type.
    //
    // For streaming this will normally be:
    //
    // text/event-stream
    //

    const contentType =
        upstreamResponse.headers.get('content-type');

    if (contentType) {
        res.setHeader('content-type', contentType);
    }

    //
    // Stream the vLLM response directly back to the caller.
    //
    // This is important for VS Code.
    //

    if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    break;
                }

                res.write(Buffer.from(value));
            }
        } catch (error) {
            console.error('[stream error]', error);
        }
    }

    res.end();
}


//
// Main HTTP server
//

const server = http.createServer(async (req, res) => {
    try {
        //
        // Health
        //

        if (
            req.method === 'GET' &&
            req.url === '/health'
        ) {
            handleHealth(res);
            return;
        }

        //
        // Models
        //

        if (
            req.method === 'GET' &&
            req.url === '/v1/models'
        ) {
            handleModels(res);
            return;
        }

        //
        // Chat completions
        //

        if (
            req.method === 'POST' &&
            req.url === '/v1/chat/completions'
        ) {
            await handleChatCompletions(req, res);
            return;
        }

        //
        // Everything else
        //

        sendJson(res, 404, {
            error: {
                message: 'Not found',
                type: 'not_found'
            }
        });

    } catch (error) {
        console.error('[server error]', error);

        if (!res.headersSent) {
            sendJson(res, 500, {
                error: {
                    message: 'Internal server error',
                    type: 'internal_error'
                }
            });
        } else {
            res.end();
        }
    }
});


//
// Start
//

server.listen(PORT, HOST, () => {
    console.log('');
    console.log('========================================');
    console.log(' Nemotron Proxy');
    console.log('========================================');
    console.log(` Listening: http://${HOST}:${PORT}`);
    console.log(` vLLM:      ${VLLM_URL}`);
    console.log(` Model:     ${VLLM_MODEL}`);
    console.log('');
    console.log(' Models:');
    console.log(
        '  nemotron-thinking  -> enable_thinking=true'
    );
    console.log(
        '  nemotron-execution -> enable_thinking=false'
    );
    console.log('');
});
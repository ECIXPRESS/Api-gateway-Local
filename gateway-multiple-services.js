const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();
const GATEWAY_PORT = 8081;

// Configuración CORS más permisiva
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With', 'Origin'],
    exposedHeaders: ['Authorization'],
    credentials: true
}));

// Manejar preflight OPTIONS requests globalmente
app.options('*', cors());

// MIDDLEWARE CRÍTICO: Eliminar header Expect que causa problemas
app.use((req, res, next) => {
    if (req.headers['expect'] || req.headers['expect'] === '100-continue') {
        console.log('[GATEWAY] Eliminando header Expect problemático');
        delete req.headers['expect'];
    }
    
    if (!req.headers['content-type'] && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
        req.headers['content-type'] = 'application/json';
    }
    
    next();
});

// Body parsing middleware
app.use(express.json({ 
    limit: '10mb',
    verify: (req, res, buf) => {
        try {
            if (buf && buf.length > 0) {
                JSON.parse(buf.toString());
            }
        } catch (e) {
            console.log('[GATEWAY] Body JSON no válido, pero continuando...');
        }
    }
}));

app.use(express.urlencoded({ 
    extended: true,
    limit: '10mb'
}));

// Configuración de servicios
const services = {
    usuarios: process.env.USERS_SERVICE_URL || 'http://localhost:8080',
    autenticacion: process.env.AUTH_SERVICE_URL || 'http://localhost:8082',
    notificaciones: process.env.NOTIFICATIONS_SERVICE_URL || 'http://localhost:8083',
    chat: process.env.CHAT_SERVICE_URL || 'http://localhost:8084',
    pagos: process.env.PAYMENTS_SERVICE_URL || 'http://localhost:8085' // Nuevo servicio de pagos
};

console.log('Configuración de servicios:');
console.log('- Usuarios:', services.usuarios);
console.log('- Autenticación:', services.autenticacion);
console.log('- Notificaciones:', services.notificaciones);
console.log('- Chat:', services.chat);
console.log('- Pagos:', services.pagos); // Nuevo log

// Log de peticiones detallado
app.use((req, res, next) => {
    console.log(`\n[GATEWAY] ======== NUEVA PETICIÓN ========`);
    console.log(`[GATEWAY] ${req.method} ${req.originalUrl}`);
    console.log(`[GATEWAY] Headers:`, JSON.stringify(req.headers, null, 2));
    
    if (req.body && Object.keys(req.body).length > 0) {
        console.log(`[GATEWAY] Body:`, JSON.stringify(req.body, null, 2));
    } else {
        console.log(`[GATEWAY] Body: vacío o no JSON`);
    }
    
    next();
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'Gateway funcionando', 
        port: GATEWAY_PORT,
        environment: process.env.NODE_ENV || 'development',
        microservicios: services,
        timestamp: new Date().toISOString()
    });
});

// Configuración para proxies
const createProxyOptions = (serviceName, target) => ({
    target: target,
    changeOrigin: true,
    timeout: 30000,
    proxyTimeout: 30000,
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-${serviceName}] Proxying to: ${target}${req.url}`);
        console.log(`[GATEWAY-${serviceName}] Method: ${req.method}`);
        
        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');
        
        proxyReq.setHeader('Accept', 'application/json');
        proxyReq.setHeader('X-Forwarded-For', req.ip);
        proxyReq.setHeader('X-Forwarded-Host', req.hostname);
        proxyReq.setHeader('X-Forwarded-Proto', req.protocol);
        
        if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
            const bodyData = JSON.stringify(req.body);
            console.log(`[GATEWAY-${serviceName}] Body data: ${bodyData}`);
            
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        console.log(`[GATEWAY-${serviceName}] Response Status: ${proxyRes.statusCode}`);
        console.log(`[GATEWAY-${serviceName}] Response Headers:`, JSON.stringify(proxyRes.headers, null, 2));
        
        proxyRes.headers['access-control-allow-origin'] = '*';
        proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
        proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization, Accept, X-Requested-With, Origin';
    },
    onError: (err, req, res) => {
        console.error(`[GATEWAY-${serviceName}] Proxy error:`, err.message);
        console.error(`[GATEWAY-${serviceName}] Error code:`, err.code);
        
        if (err.code === 'ECONNREFUSED') {
            res.status(503).json({ 
                error: `Servicio ${serviceName} no disponible`,
                message: `No se puede conectar a ${target}`,
                details: err.message,
                timestamp: new Date().toISOString()
            });
        } else if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
            res.status(504).json({ 
                error: `Timeout del servicio ${serviceName}`,
                message: `El servicio no respondió a tiempo`,
                details: err.message,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({ 
                error: `Error en proxy ${serviceName}`,
                message: err.message,
                code: err.code,
                timestamp: new Date().toISOString()
            });
        }
    }
});

// **CORRECCIÓN: Proxy para Gestión de Usuarios con nuevos endpoints de password reset**
app.use('/api/users', createProxyMiddleware({
    ...createProxyOptions('USERS', services.usuarios),
    pathRewrite: {
        '^/api/users': '/users'
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-USERS] === PROXY USERS DETALLADO ===`);
        console.log(`[GATEWAY-USERS] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-USERS] Rewritten URL: /users${req.url.replace('/api/users', '')}`);
        
        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');
        
        if (req.body) {
            console.log(`[GATEWAY-USERS] Body recibido:`, JSON.stringify(req.body, null, 2));
            
            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-USERS] Body enviado: ${bodyData}`);
            }
        }
        
        console.log(`[GATEWAY-USERS] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// Proxy para Autenticación
app.use('/api/auth', createProxyMiddleware({
    ...createProxyOptions('AUTH', services.autenticacion),
    pathRewrite: {
        '^/api/auth': '/auth'
    }
}));

// Proxy para User Info
app.use('/api/user-info', createProxyMiddleware({
    ...createProxyOptions('USER-INFO', services.autenticacion),
    pathRewrite: {
        '^/api/user-info': '/user-info'
    }
}));

// Proxy para Notificaciones
app.use('/api/notifications', createProxyMiddleware({
    ...createProxyOptions('NOTIFICATIONS', services.notificaciones),
    pathRewrite: {
        '^/api/notifications': '/notifications'
    }
}));

// Proxy para Chat
app.use('/api/chat', createProxyMiddleware({
    ...createProxyOptions('CHAT', services.chat),
    pathRewrite: {
        '^/api/chat': ''  // Elimina /api/chat y mantiene el resto de la ruta
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-CHAT] === PROXY CHAT DETALLADO ===`);
        console.log(`[GATEWAY-CHAT] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-CHAT] Rewritten URL: ${req.url.replace('/api/chat', '')}`);
        
        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');
        
        if (req.body) {
            console.log(`[GATEWAY-CHAT] Body recibido:`, JSON.stringify(req.body, null, 2));
            
            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-CHAT] Body enviado: ${bodyData}`);
            }
        }
        
        console.log(`[GATEWAY-CHAT] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// **NUEVO: Proxy para Pagos**
app.use('/api/payments', createProxyMiddleware({
    ...createProxyOptions('PAYMENTS', services.pagos),
    pathRewrite: {
        '^/api/payments': '/api/v1/payments'  // Mapea a la ruta base del controlador de pagos
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-PAYMENTS] === PROXY PAYMENTS DETALLADO ===`);
        console.log(`[GATEWAY-PAYMENTS] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-PAYMENTS] Rewritten URL: /api/v1/payments${req.url.replace('/api/payments', '')}`);
        
        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');
        
        if (req.body) {
            console.log(`[GATEWAY-PAYMENTS] Body recibido:`, JSON.stringify(req.body, null, 2));
            
            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-PAYMENTS] Body enviado: ${bodyData}`);
            }
        }
        
        console.log(`[GATEWAY-PAYMENTS] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// Ruta para verificar configuración
app.get('/config', (req, res) => {
    res.json({
        gateway: {
            port: GATEWAY_PORT,
            environment: process.env.NODE_ENV || 'development'
        },
        services: services,
        passwordResetEndpoints: {
            'POST /api/users/password/reset-request': 'Solicitar código de verificación',
            'POST /api/users/password/verify-code': 'Verificar código',
            'PUT /api/users/password/reset': 'Cambiar contraseña'
        },
        customerEndpoints: {
            'POST /api/users/customers': 'Crear customer',
            'GET /api/users/customers/:customerId': 'Obtener customer por ID',
            'PUT /api/users/customers/:customerId/password': 'Actualizar password',
            'PUT /api/users/customers/:customerId': 'Actualizar customer',
            'DELETE /api/users/customers/:customerId': 'Eliminar customer'
        },
        chatEndpoints: {
            // Conversaciones
            'POST /api/chat/eciexpress/conversations': 'Crear conversación',
            'DELETE /api/chat/eciexpress/conversations': 'Eliminar conversación',
            'GET /api/chat/eciexpress/conversations/{id}/messages': 'Obtener mensajes de conversación',
            
            // Usuario de Chat
            'GET /api/chat/eciexpress/chatuser/{id}/filter/contacts': 'Filtrar contactos',
            'GET /api/chat/eciexpress/chatuser/{id}/contacts': 'Obtener contactos',
            'GET /api/chat/eciexpress/chatuser/{id}/messages': 'Obtener mensajes en conversación',
            'GET /api/chat/eciexpress/chatuser/{id}/conversations': 'Obtener conversaciones del usuario',
            'POST /api/chat/eciexpress/chatuser/add-contact': 'Agregar contacto',
            'POST /api/chat/eciexpress/chatuser/create-test-users': 'Crear usuarios de prueba (TEST)'
        },
        paymentEndpoints: {
            'POST /api/payments/ProcessPayment': 'Procesar un nuevo pago'
        }
    });
});

// Ruta para test de proxy
app.get('/api/test-proxy', (req, res) => {
    res.json({
        message: 'Test de proxy exitoso',
        services: services,
        timestamp: new Date().toISOString()
    });
});

// Ruta principal
app.get('/', (req, res) => {
    res.json({
        message: 'Gateway funcionando - SERVICIOS DE CHAT Y PAGOS AGREGADOS',
        environment: process.env.NODE_ENV || 'development',
        microservicios: services,
        passwordResetEndpoints: [
            'POST /api/users/password/reset-request',
            'POST /api/users/password/verify-code', 
            'PUT /api/users/password/reset'
        ],
        customerEndpoints: [
            'POST /api/users/customers',
            'GET /api/users/customers/:customerId', 
            'PUT /api/users/customers/:customerId/password',
            'PUT /api/users/customers/:customerId',
            'DELETE /api/users/customers/:customerId'
        ],
        chatEndpoints: [
            'POST /api/chat/eciexpress/conversations',
            'DELETE /api/chat/eciexpress/conversations',
            'GET /api/chat/eciexpress/conversations/:id/messages',
            'GET /api/chat/eciexpress/chatuser/:id/filter/contacts',
            'GET /api/chat/eciexpress/chatuser/:id/contacts',
            'GET /api/chat/eciexpress/chatuser/:id/messages',
            'GET /api/chat/eciexpress/chatuser/:id/conversations',
            'POST /api/chat/eciexpress/chatuser/add-contact',
            'POST /api/chat/eciexpress/chatuser/create-test-users'
        ],
        paymentEndpoints: [
            'POST /api/payments/ProcessPayment'
        ],
        timestamp: new Date().toISOString()
    });
});

// Middleware para log de errores
app.use((err, req, res, next) => {
    console.error('[GATEWAY] Error no manejado:', err);
    console.error('[GATEWAY] Error stack:', err.stack);
    
    res.status(500).json({
        error: 'Error interno del gateway',
        message: err.message,
        timestamp: new Date().toISOString()
    });
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
    console.log(`[GATEWAY] Ruta no encontrada: ${req.originalUrl}`);
    res.status(404).json({
        error: 'Ruta no encontrada',
        message: `La ruta ${req.originalUrl} no existe`,
        available_routes: [
            '/api/auth/*',
            '/api/user-info/*', 
            '/api/users/*',
            '/api/notifications/*',
            '/api/chat/*',
            '/api/payments/*', // Nueva ruta agregada
            '/health',
            '/config',
            '/api/test-proxy'
        ],
        timestamp: new Date().toISOString()
    });
});

app.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log('GATEWAY ACTUALIZADO - SERVICIOS DE CHAT Y PAGOS AGREGADOS');
    console.log('=========================================');
    console.log(`URL: http://localhost:${GATEWAY_PORT}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Microservicios configurados:');
    console.log(`- Gestión de Usuarios: ${services.usuarios}`);
    console.log(`- Autenticación: ${services.autenticacion}`);
    console.log(`- Notificaciones: ${services.notificaciones}`);
    console.log(`- Chat: ${services.chat}`);
    console.log(`- Pagos: ${services.pagos}`);
    console.log('Endpoints de Chat:');
    console.log('- POST   /api/chat/eciexpress/conversations');
    console.log('- DELETE /api/chat/eciexpress/conversations');
    console.log('- GET    /api/chat/eciexpress/conversations/:id/messages');
    console.log('- GET    /api/chat/eciexpress/chatuser/:id/filter/contacts');
    console.log('- GET    /api/chat/eciexpress/chatuser/:id/contacts');
    console.log('- GET    /api/chat/eciexpress/chatuser/:id/messages');
    console.log('- GET    /api/chat/eciexpress/chatuser/:id/conversations');
    console.log('- POST   /api/chat/eciexpress/chatuser/add-contact');
    console.log('- POST   /api/chat/eciexpress/chatuser/create-test-users');
    console.log('Endpoints de Pagos:');
    console.log('- POST   /api/payments/ProcessPayment');
    console.log('=========================================');
});


process.on('SIGINT', () => {
    console.log('\n[GATEWAY] Apagando gateway...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[GATEWAY] Apagando gateway...');
    process.exit(0);
});
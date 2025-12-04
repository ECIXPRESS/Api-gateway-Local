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

// ===================================================================
// NUEVA Configuración de servicios (Usando variables de entorno para Azure URLs)
// ===================================================================
const services = {
    stock: process.env.STOCK_SERVICE_URL || 'https://kappa-stock-dev-gdgqbqegdqfce8ad.mexicocentral-01.azurewebsites.net/',   // Stock Microservice (Products, Stock, Alerts)
    orders: process.env.ORDERS_SERVICE_URL || 'https://kappa-orders-dev-fbeea3c4gbfrhyhf.mexicocentral-01.azurewebsites.net/',  // Orders Microservice
    stats: process.env.STATS_SERVICE_URL || 'https://kappa-stats-dev-bqbahbc6e2araxa2.mexicocentral-01.azurewebsites.net/', // Stats Microservice
    schedule: process.env.SCHEDULE_SERVICE_URL || 'https://kappa-schedule-dev-ffgaeaa7cva3baa7.mexicocentral-01.azurewebsites.net/' // Orders Schedule Microservice
};

console.log('Configuración de servicios:');
console.log('- Stock (Azure):', services.stock);
console.log('- Orders (Azure):', services.orders);

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
        // Logging and standard header setting (unchanged)
        console.log(`[GATEWAY-${serviceName}] Proxying to: ${target}${req.url}`);

        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');

        proxyReq.setHeader('Accept', 'application/json');
        proxyReq.setHeader('X-Forwarded-For', req.ip);
        proxyReq.setHeader('X-Forwarded-Host', req.hostname);
        proxyReq.setHeader('X-Forwarded-Proto', req.protocol);

        if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
            }
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // CORS and header logging (unchanged)
        proxyRes.headers['access-control-allow-origin'] = '*';
        proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
        proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization, Accept, X-Requested-With, Origin';
    },
    onError: (err, req, res) => {
        // Error handling (unchanged)
        console.error(`[GATEWAY-${serviceName}] Proxy error:`, err.message);

        if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
            res.status(503).json({
                error: `Servicio ${serviceName} no disponible`,
                message: `No se puede conectar a ${target} (Verificar Azure URL)`,
                details: err.message,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json({ error: `Error en proxy ${serviceName}`, message: err.message });
        }
    }
});

// -------------------------------------------------------------------
// NUEVOS PROXIES BASADOS EN CONTROLADORES DE AZURE (Stock Microservice)
// -------------------------------------------------------------------

// 1. Proxy para Product CRUD y Stock Management
// (ProductController @RequestMapping("/api/products") and StockController @RequestMapping("/api/products/{productId}/stock"))
app.use('/api/products', createProxyMiddleware({
    ...createProxyOptions('STOCK-PRODUCTS', services.stock),
    pathRewrite: {
        '^/api/products': '/api/products'
    }
}));

// 2. Proxy para Stock Alerts
// (StockAlertController @RequestMapping("/api/stock-alerts"))
app.use('/api/stock-alerts', createProxyMiddleware({
    ...createProxyOptions('STOCK-ALERTS', services.stock),
    pathRewrite: {
        '^/api/stock-alerts': '/api/stock-alerts'
    }
}));

// 3. Proxy para Orders Microservice
// (OrdersController @RequestMapping("/api/orders"))
app.use('/api/orders', createProxyMiddleware({
    ...createProxyOptions('ORDERS', services.orders),
    pathRewrite: {
        '^/api/orders': '/api/orders'
    }
}));

// 4. Proxy para Stats Microservice
// (StatsController @RequestMapping("/api/statistics"))
app.use('api/statistics', createProxyMiddleware({
    ...createProxyOptions('STATS', services.stats),
    pathRewrite: {
        '^/api/statistics': '/api/statistics'
    }
}))

// 5. Proxy para Stats Microservice
// (ScheduleController @RequestMapping("/api/schedule"))
app.use('api/schedule', createProxyMiddleware({
    ...createProxyOptions('SCHEDULE', services.schedule),
    pathRewrite: {
        '^/api/schedule': '/api/schedule'
    }
}))


// -------------------------------------------------------------------
// RUTAS DE INFORMACIÓN DEL GATEWAY (Actualizadas)
// -------------------------------------------------------------------

// Ruta para verificar configuración
app.get('/config', (req, res) => {
    res.json({
        gateway: {
            port: GATEWAY_PORT,
            environment: process.env.NODE_ENV || 'development'
        },
        services: services,
        stockEndpoints: {
            'POST /api/products': 'Crear producto',
            'GET /api/products/:id': 'Obtener producto por ID',
            'GET /api/products': 'Listar productos',
            'DELETE /api/products/:id': 'Eliminar producto',
            'PUT /api/products/:id': 'Actualizar producto',
            'PATCH /api/products/:id': 'Modificar parcialmente producto',

            'POST /api/products/:id/stock/increase': 'Aumentar stock',
            'POST /api/products/:id/stock/decrease': 'Disminuir stock',

            'GET /api/stock-alerts/active': 'Obtener alertas activas',
            'GET /api/stock-alerts/product/:productId': 'Obtener alertas de un producto específico',
        },
        orderEndpoints: {
            'POST /api/orders': 'Crear pedido',
            'POST /api/orders/:id/items': 'Agregar lo que se va a comprar',
            'GET /api/orders/:id': 'Consultar pedido por ID',
            'GET /api/orders/user/:userId': 'Listar pedidos por usuario',
            'PUT /api/orders/:id/status': 'Actualizar estado del pedido',
            'PUT /api/orders/:id/cancel': 'Cancelar el pedido',
            'GET /api/orders/status/:status': 'Listar pedidos por estado',
            'GET /api/orders/user/:id/history': 'Consulta historial de un usuario',
            'GET /api/orders/:id/items':'Obtiene los items del pedido',
            'GET /api/orders/:id/total':'Obtiene el valor total del pedido',
            'PUT /api/orders/:id/estimated-time':'Actualiza el tiempo estimado',
            'PUT /api/orders/:id/confirm':'Confirma el pedido',
            'PUT /api/orders/:id/preparation':'Marca el pedido en preparación',
            'PUT /api/orders/:id/ready':'Marcar pedido como listo',
            'PUT /api/orders/:id/deliver':'Marcar pedido como entregado',
            'GET /api/orders/date/:date' : 'Buscar pedidos por fecha',
            'GET /api/orders/location/:location':'Listar pedidos por ubicación',
            'GET /api/orders/pending':'Listar pedidos pendientes',
            'GET /api/orders/completed/today':'Listar pedidos completados hoy',
            'GET /api/orders/user/:id/count':'Contar pedidos por usuario',
            'GET /api/orders/:id/exists':'Verificar la existencia de un pedido',
            'DELETE /api/orders/:id':'Eliminar un pedido'
        }
    });
});

// Ruta principal
app.get('/', (req, res) => {
    res.json({
        message: 'Gateway funcionando - SERVICIOS STOCK, PEDIDOS, HORARIOS Y ESTADÍSTICAS (AZURE)',
        environment: process.env.NODE_ENV || 'development',
        microservicios: services,
        endpoints_available: [
            '/api/products/*',
            '/api/stock-alerts/*',
            '/api/orders/*',
            'api/statistics/*',
            'api/schedule/*',
            '/health',
            '/config',
            '/api/test-proxy'
        ],
        timestamp: new Date().toISOString()
    });
});

// Middleware para log de errores y rutas no encontradas (UNCHANGED)
app.use((err, req, res, next) => {
    // ... error logging ...
    res.status(500).json({ error: 'Error interno del gateway', message: err.message });
});

app.use('*', (req, res) => {
    // ... 404 handling ...
    res.status(404).json({ error: 'Ruta no encontrada', message: `La ruta ${req.originalUrl} no existe` });
});


app.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log('GATEWAY ACTUALIZADO - SERVICIOS AZURE');
    console.log('=========================================');
    console.log(`URL: http://localhost:${GATEWAY_PORT}`);
    console.log(`- Stock (Azure) Endpoints: /api/products/*, /api/stock-alerts/*`);
    console.log(`- Orders (Azure) Endpoints: /api/orders/*`);
    console.log(`- Statistics (Azure) Endpoints: /api/statistics/*`);
    console.log(`- OperationSchedule (Azure) Endpoints: /api/schedule/*`);
    console.log('=========================================');
});

// ... process listeners (SIGINT, SIGTERM) ...
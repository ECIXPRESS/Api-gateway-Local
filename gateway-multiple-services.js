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

// Configuración de servicios - AGREGADOS SERVICIOS DE STOCK Y STATISTICS
const services = {
    usuarios: process.env.USERS_SERVICE_URL || 'http://localhost:8080',
    autenticacion: process.env.AUTH_SERVICE_URL || 'http://localhost:8082',
    notificaciones: process.env.NOTIFICATIONS_SERVICE_URL || 'http://localhost:8083',
    chat: process.env.CHAT_SERVICE_URL || 'http://localhost:8084',
    pagos: process.env.PAYMENTS_SERVICE_URL || 'http://localhost:8085',
    ordenes: process.env.ORDERS_SERVICE_URL || 'http://localhost:8086',
    schedule: process.env.SCHEDULE_SERVICE_URL || 'http://localhost:8087',
    stock: process.env.STOCK_SERVICE_URL || 'http://localhost:8088', // Nuevo servicio de stock
    statistics: process.env.STATISTICS_SERVICE_URL || 'http://localhost:8089' // Nuevo servicio de estadísticas
};

console.log('Configuración de servicios:');
console.log('- Usuarios:', services.usuarios);
console.log('- Autenticación:', services.autenticacion);
console.log('- Notificaciones:', services.notificaciones);
console.log('- Chat:', services.chat);
console.log('- Pagos:', services.pagos);
console.log('- Órdenes:', services.ordenes);
console.log('- Schedule/Horarios:', services.schedule);
console.log('- Stock/Inventario:', services.stock);
console.log('- Statistics/Estadísticas:', services.statistics);

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

// Proxy para Gestión de Usuarios
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

// Proxy para Pagos
app.use('/api/payments', createProxyMiddleware({
    ...createProxyOptions('PAYMENTS', services.pagos),
    pathRewrite: {
        '^/api/payments': '/api/v1/payments'
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

// Proxy para Gestión de Órdenes/Pedidos
app.use('/api/orders', createProxyMiddleware({
    ...createProxyOptions('ORDERS', services.ordenes),
    pathRewrite: {
        '^/api/orders': '/api/orders'
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-ORDERS] === PROXY ORDERS DETALLADO ===`);
        console.log(`[GATEWAY-ORDERS] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-ORDERS] Rewritten URL: /api/orders${req.url.replace('/api/orders', '')}`);

        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');

        if (req.body) {
            console.log(`[GATEWAY-ORDERS] Body recibido:`, JSON.stringify(req.body, null, 2));

            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-ORDERS] Body enviado: ${bodyData}`);
            }
        }

        console.log(`[GATEWAY-ORDERS] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// Proxy para Gestión de Schedule/Horarios
app.use('/api/schedule', createProxyMiddleware({
    ...createProxyOptions('SCHEDULE', services.schedule),
    pathRewrite: {
        '^/api/schedule': '/api/schedule'
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-SCHEDULE] === PROXY SCHEDULE DETALLADO ===`);
        console.log(`[GATEWAY-SCHEDULE] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-SCHEDULE] Rewritten URL: /api/schedule${req.url.replace('/api/schedule', '')}`);

        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');

        if (req.body) {
            console.log(`[GATEWAY-SCHEDULE] Body recibido:`, JSON.stringify(req.body, null, 2));

            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-SCHEDULE] Body enviado: ${bodyData}`);
            }
        }

        console.log(`[GATEWAY-SCHEDULE] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// NUEVO: Proxy para Gestión de Stock/Productos
app.use('/api/products', createProxyMiddleware({
    ...createProxyOptions('STOCK', services.stock),
    pathRewrite: {
        '^/api/products': '/api/products'  // Mantiene la misma ruta base
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-STOCK] === PROXY STOCK DETALLADO ===`);
        console.log(`[GATEWAY-STOCK] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-STOCK] Rewritten URL: /api/products${req.url.replace('/api/products', '')}`);

        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');

        if (req.body) {
            console.log(`[GATEWAY-STOCK] Body recibido:`, JSON.stringify(req.body, null, 2));

            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-STOCK] Body enviado: ${bodyData}`);
            }
        }

        console.log(`[GATEWAY-STOCK] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// NUEVO: Proxy para Stock Alerts (rutas específicas)
app.use('/api/stock-alerts', createProxyMiddleware({
    ...createProxyOptions('STOCK-ALERTS', services.stock),
    pathRewrite: {
        '^/api/stock-alerts': '/api/stock-alerts'
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-STOCK-ALERTS] === PROXY STOCK ALERTS DETALLADO ===`);
        console.log(`[GATEWAY-STOCK-ALERTS] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-STOCK-ALERTS] Rewritten URL: /api/stock-alerts${req.url.replace('/api/stock-alerts', '')}`);

        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');

        if (req.body) {
            console.log(`[GATEWAY-STOCK-ALERTS] Body recibido:`, JSON.stringify(req.body, null, 2));

            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-STOCK-ALERTS] Body enviado: ${bodyData}`);
            }
        }

        console.log(`[GATEWAY-STOCK-ALERTS] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    }
}));

// NUEVO: Proxy para Statistics/Estadísticas
app.use('/api/statistics', createProxyMiddleware({
    ...createProxyOptions('STATISTICS', services.statistics),
    pathRewrite: {
        '^/api/statistics': '/api/statistics'
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`[GATEWAY-STATISTICS] === PROXY STATISTICS DETALLADO ===`);
        console.log(`[GATEWAY-STATISTICS] Original URL: ${req.originalUrl}`);
        console.log(`[GATEWAY-STATISTICS] Rewritten URL: /api/statistics${req.url.replace('/api/statistics', '')}`);

        proxyReq.removeHeader('expect');
        proxyReq.removeHeader('Expect');

        // Para la exportación de Excel, manejar headers específicos
        if (req.query.export || req.url.includes('/export')) {
            proxyReq.setHeader('Accept', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json');
        }

        if (req.body) {
            console.log(`[GATEWAY-STATISTICS] Body recibido:`, JSON.stringify(req.body, null, 2));

            const bodyData = JSON.stringify(req.body);
            if (bodyData && bodyData !== '{}') {
                proxyReq.setHeader('Content-Type', 'application/json');
                proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
                proxyReq.write(bodyData);
                console.log(`[GATEWAY-STATISTICS] Body enviado: ${bodyData}`);
            }
        }

        console.log(`[GATEWAY-STATISTICS] Headers finales:`, JSON.stringify(proxyReq.getHeaders(), null, 2));
    },
    onProxyRes: (proxyRes, req, res) => {
        console.log(`[GATEWAY-STATISTICS] Response Status: ${proxyRes.statusCode}`);

        // Para la exportación de Excel, propagar headers específicos
        if (req.url.includes('/export') || req.query.export) {
            proxyRes.headers['Content-Disposition'] = proxyRes.headers['content-disposition'] || 'attachment; filename=statistics.xlsx';
            proxyRes.headers['Content-Type'] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        }

        proxyRes.headers['access-control-allow-origin'] = '*';
        proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS, PATCH';
        proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization, Accept, X-Requested-With, Origin';

        console.log(`[GATEWAY-STATISTICS] Response Headers:`, JSON.stringify(proxyRes.headers, null, 2));
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
            'POST /api/chat/eciexpress/conversations': 'Crear conversación',
            'DELETE /api/chat/eciexpress/conversations': 'Eliminar conversación',
            'GET /api/chat/eciexpress/conversations/{id}/messages': 'Obtener mensajes de conversación',
            'GET /api/chat/eciexpress/chatuser/{id}/filter/contacts': 'Filtrar contactos',
            'GET /api/chat/eciexpress/chatuser/{id}/contacts': 'Obtener contactos',
            'GET /api/chat/eciexpress/chatuser/{id}/messages': 'Obtener mensajes en conversación',
            'GET /api/chat/eciexpress/chatuser/{id}/conversations': 'Obtener conversaciones del usuario',
            'POST /api/chat/eciexpress/chatuser/add-contact': 'Agregar contacto',
            'POST /api/chat/eciexpress/chatuser/create-test-users': 'Crear usuarios de prueba (TEST)'
        },
        paymentEndpoints: {
            'POST /api/payments/ProcessPayment': 'Procesar un nuevo pago'
        },
        ordersEndpoints: {
            'POST /api/orders': 'Crea un nuevo pedido',
            'POST /api/orders/{orderId}/items': 'Agrega items a un pedido',
            'GET /api/orders/{orderId}': 'Consulta un pedido por ID',
            'GET /api/orders/{orderId}/items': 'Obtiene items de un pedido',
            'GET /api/orders/{orderId}/total': 'Calcula total del pedido',
            'GET /api/orders/{orderId}/exists': 'Verifica existencia de pedido',
            'DELETE /api/orders/{orderId}': 'Eliminar pedido',
            'GET /api/orders/user/{userId}': 'Lista pedidos por usuario',
            'GET /api/orders/user/{userId}/history': 'Consulta historial de usuario',
            'GET /api/orders/user/{userId}/count': 'Contar pedidos por usuario',
            'PUT /api/orders/{orderId}/status': 'Actualiza estado del pedido',
            'PUT /api/orders/{orderId}/cancel': 'Cancela el pedido',
            'PUT /api/orders/{orderId}/confirm': 'Confirmar pedido',
            'PUT /api/orders/{orderId}/preparation': 'Marcar en preparación',
            'PUT /api/orders/{orderId}/ready': 'Marcar como listo',
            'PUT /api/orders/{orderId}/deliver': 'Marcar como entregado',
            'GET /api/orders/status/{status}': 'Lista pedidos por estado',
            'GET /api/orders/pending': 'Ver pedidos pendientes',
            'GET /api/orders/completed/today': 'Ver pedidos completados hoy',
            'GET /api/orders/date/{date}': 'Buscar pedidos por fecha',
            'GET /api/orders/location/{location}': 'Listar pedidos por ubicación',
            'PUT /api/orders/{orderId}/estimated-time': 'Actualizar tiempo estimado'
        },
        scheduleEndpoints: {
            'POST   /api/schedule/categories': 'Crear schedule de categoría',
            'PUT    /api/schedule/categories/{id}': 'Actualizar schedule de categoría',
            'PATCH  /api/schedule/categories/{id}/status': 'Cambiar estado de categoría',
            'GET    /api/schedule/categories': 'Obtener todos los schedules de categorías',
            'GET    /api/schedule/categories/active': 'Obtener categorías activas',
            'GET    /api/schedule/categories/{categoryName}': 'Obtener schedule de categoría específica',
            'GET    /api/schedule/categories/{categoryName}/active': 'Obtener categoría activa específica',
            'GET    /api/schedule/categories/{categoryName}/status': 'Verificar si categoría está activa',
            'DELETE /api/schedule/categories/{id}': 'Eliminar schedule de categoría',
            'POST /api/schedule/availability': 'Verificar disponibilidad',
            'POST /api/schedule/availability/with-suggestions': 'Verificar disponibilidad con sugerencias',
            'POST /api/schedule/availability/order': 'Validar disponibilidad de orden',
            'GET    /api/schedule/time-slots/{pointOfSaleId}': 'Obtener slots disponibles por punto de venta',
            'POST   /api/schedule/time-slots': 'Crear time slot manualmente',
            'POST   /api/schedule/time-slots/generate': 'Generar slots automáticamente',
            'POST   /api/schedule/time-slots/{slotId}/reserve': 'Reservar time slot',
            'POST   /api/schedule/time-slots/{slotId}/release': 'Liberar time slot',
            'GET    /api/schedule/time-slots/available': 'Obtener slots con filtros',
            'GET    /api/schedule/time-slots/{pointOfSaleId}/now': 'Slots disponibles ahora',
            'GET    /api/schedule/time-slots/{pointOfSaleId}/closures-validation': 'Slots validando cierres',
            'POST   /api/schedule/operating-hours': 'Crear horario operativo',
            'PUT    /api/schedule/operating-hours/{id}': 'Actualizar horario operativo',
            'PATCH  /api/schedule/operating-hours/{id}/status': 'Cambiar estado de horario',
            'GET    /api/schedule/operating-hours': 'Obtener todos los horarios',
            'GET    /api/schedule/operating-hours/{pointOfSaleId}/active': 'Horarios activos por punto de venta',
            'GET    /api/schedule/operating-hours/active': 'Todos los horarios activos',
            'POST   /api/schedule/temporary-closures': 'Crear cierre temporal',
            'GET    /api/schedule/temporary-closures/{pointOfSaleId}': 'Cierres por punto de venta',
            'GET    /api/schedule/temporary-closures': 'Todos los cierres',
            'GET    /api/schedule/temporary-closures/active/range': 'Cierres activos en rango',
            'PUT    /api/schedule/temporary-closures/{id}': 'Actualizar cierre',
            'PATCH  /api/schedule/temporary-closures/{id}/status': 'Cambiar estado de cierre',
            'DELETE /api/schedule/temporary-closures/{id}': 'Eliminar cierre',
            'GET /api/schedule/reports/{pointOfSaleId}': 'Reporte de punto de venta',
            'GET /api/schedule/reports/availability': 'Reporte de disponibilidad',
            'GET /api/schedule/reports/categories': 'Reporte de schedules de categorías',
            'GET /api/schedule/reports/time-slots/occupancy': 'Reporte de ocupación de slots',
            'GET /api/schedule/reports/time-slots/peak-hours': 'Reporte de horas pico',
            'GET /api/schedule/reports/time-slots/capacity-utilization': 'Reporte de utilización de capacidad'
        },
        stockEndpoints: {
            // Product Management
            'POST   /api/products': 'Crear un nuevo producto',
            'GET    /api/products': 'Obtener todos los productos',
            'GET    /api/products/{id}': 'Obtener producto por ID',
            'PUT    /api/products/{id}': 'Actualizar producto completamente',
            'PATCH  /api/products/{id}': 'Actualizar producto parcialmente',
            'DELETE /api/products/{id}': 'Eliminar producto',

            // Stock Management
            'POST /api/products/{productId}/stock/increase': 'Aumentar stock del producto',
            'POST /api/products/{productId}/stock/decrease': 'Disminuir stock del producto',

            // Stock Alerts
            'GET /api/stock-alerts/active': 'Obtener alertas de stock activas',
            'GET /api/stock-alerts/product/{productId}': 'Obtener alertas por producto'
        },
        statisticsEndpoints: {
            // Reports
            'GET /api/statistics/daily': 'Reporte de ventas diarias',
            'GET /api/statistics/weekly': 'Reporte de ventas semanales',
            'GET /api/statistics/monthly': 'Reporte de ventas mensuales',
            'GET /api/statistics/summary': 'Resumen estadístico general',
            'GET /api/statistics/top-products': 'Ranking de productos más vendidos',

            // Export
            'GET /api/statistics/export': 'Exportar todas las estadísticas en Excel'
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
        message: 'Gateway funcionando - TODOS LOS SERVICIOS AGREGADOS',
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
        ordersEndpoints: [
            'POST /api/orders',
            'POST /api/orders/:orderId/items',
            'GET /api/orders/:orderId',
            'GET /api/orders/user/:userId',
            'GET /api/orders/:orderId/items',
            'GET /api/orders/:orderId/total',
            'GET /api/orders/:orderId/exists',
            'GET /api/orders/status/:status',
            'GET /api/orders/user/:userId/history',
            'GET /api/orders/date/:date',
            'GET /api/orders/location/:location',
            'GET /api/orders/pending',
            'GET /api/orders/completed/today',
            'GET /api/orders/user/:userId/count',
            'PUT /api/orders/:orderId/status',
            'PUT /api/orders/:orderId/cancel',
            'PUT /api/orders/:orderId/confirm',
            'PUT /api/orders/:orderId/preparation',
            'PUT /api/orders/:orderId/ready',
            'PUT /api/orders/:orderId/deliver',
            'PUT /api/orders/:orderId/estimated-time',
            'DELETE /api/orders/:orderId'
        ],
        scheduleEndpoints: [
            'POST /api/schedule/categories',
            'PUT /api/schedule/categories/:id',
            'PATCH /api/schedule/categories/:id/status',
            'GET /api/schedule/categories',
            'GET /api/schedule/categories/active',
            'GET /api/schedule/categories/:categoryName',
            'GET /api/schedule/categories/:categoryName/active',
            'GET /api/schedule/categories/:categoryName/status',
            'DELETE /api/schedule/categories/:id',
            'POST /api/schedule/availability',
            'POST /api/schedule/availability/with-suggestions',
            'POST /api/schedule/availability/order',
            'GET /api/schedule/time-slots/:pointOfSaleId',
            'POST /api/schedule/time-slots',
            'POST /api/schedule/time-slots/generate',
            'POST /api/schedule/time-slots/:slotId/reserve',
            'POST /api/schedule/time-slots/:slotId/release',
            'GET /api/schedule/time-slots/available',
            'GET /api/schedule/time-slots/:pointOfSaleId/now',
            'GET /api/schedule/time-slots/:pointOfSaleId/closures-validation',
            'POST /api/schedule/operating-hours',
            'PUT /api/schedule/operating-hours/:id',
            'PATCH /api/schedule/operating-hours/:id/status',
            'GET /api/schedule/operating-hours',
            'GET /api/schedule/operating-hours/:pointOfSaleId/active',
            'GET /api/schedule/operating-hours/active',
            'POST /api/schedule/temporary-closures',
            'GET /api/schedule/temporary-closures/:pointOfSaleId',
            'GET /api/schedule/temporary-closures',
            'GET /api/schedule/temporary-closures/active/range',
            'PUT /api/schedule/temporary-closures/:id',
            'PATCH /api/schedule/temporary-closures/:id/status',
            'DELETE /api/schedule/temporary-closures/:id',
            'GET /api/schedule/reports/:pointOfSaleId',
            'GET /api/schedule/reports/availability',
            'GET /api/schedule/reports/categories',
            'GET /api/schedule/reports/time-slots/occupancy',
            'GET /api/schedule/reports/time-slots/peak-hours',
            'GET /api/schedule/reports/time-slots/capacity-utilization'
        ],
        stockEndpoints: [
            'POST /api/products',
            'GET /api/products',
            'GET /api/products/:id',
            'PUT /api/products/:id',
            'PATCH /api/products/:id',
            'DELETE /api/products/:id',
            'POST /api/products/:productId/stock/increase',
            'POST /api/products/:productId/stock/decrease',
            'GET /api/stock-alerts/active',
            'GET /api/stock-alerts/product/:productId'
        ],
        statisticsEndpoints: [
            'GET /api/statistics/daily',
            'GET /api/statistics/weekly',
            'GET /api/statistics/monthly',
            'GET /api/statistics/summary',
            'GET /api/statistics/top-products',
            'GET /api/statistics/export'
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
            '/api/payments/*',
            '/api/orders/*',
            '/api/schedule/*',
            '/api/products/*', // Nueva ruta para stock
            '/api/stock-alerts/*', // Nueva ruta para alertas de stock
            '/api/statistics/*', // Nueva ruta para estadísticas
            '/health',
            '/config',
            '/api/test-proxy'
        ],
        timestamp: new Date().toISOString()
    });
});

app.listen(GATEWAY_PORT, '0.0.0.0', () => {
    console.log('=========================================');
    console.log('GATEWAY COMPLETO - TODOS LOS SERVICIOS AGREGADOS');
    console.log('=========================================');
    console.log(`URL: http://localhost:${GATEWAY_PORT}`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
    console.log('Microservicios configurados (9 servicios):');
    console.log(`1. Gestión de Usuarios: ${services.usuarios}`);
    console.log(`2. Autenticación: ${services.autenticacion}`);
    console.log(`3. Notificaciones: ${services.notificaciones}`);
    console.log(`4. Chat: ${services.chat}`);
    console.log(`5. Pagos: ${services.pagos}`);
    console.log(`6. Órdenes: ${services.ordenes}`);
    console.log(`7. Schedule/Horarios: ${services.schedule}`);
    console.log(`8. Stock/Inventario: ${services.stock}`);
    console.log(`9. Statistics/Estadísticas: ${services.statistics}`);
    console.log('=========================================');
    console.log('Endpoints principales de Stock:');
    console.log('- POST   /api/products                 Crear producto');
    console.log('- GET    /api/products                 Listar productos');
    console.log('- GET    /api/products/{id}            Ver producto');
    console.log('- POST   /api/products/{id}/stock/increase  Aumentar stock');
    console.log('- POST   /api/products/{id}/stock/decrease  Disminuir stock');
    console.log('- GET    /api/stock-alerts/active      Alertas activas');
    console.log('=========================================');
    console.log('Endpoints principales de Statistics:');
    console.log('- GET    /api/statistics/daily         Reporte diario');
    console.log('- GET    /api/statistics/weekly        Reporte semanal');
    console.log('- GET    /api/statistics/monthly       Reporte mensual');
    console.log('- GET    /api/statistics/top-products  Ranking productos');
    console.log('- GET    /api/statistics/export        Exportar Excel');
    console.log('=========================================');
    console.log('Para ver todos los endpoints disponibles visita:');
    console.log(`- http://localhost:${GATEWAY_PORT}/config`);
    console.log(`- http://localhost:${GATEWAY_PORT}/`);
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
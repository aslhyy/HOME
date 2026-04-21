# Home | Finanzas en pareja

App móvil web para finanzas en pareja con:

- Registro y login con sesión.
- **Base de datos Firebase Firestore** (nube, sin archivo local).
- Hogar compartido con código de invitación.
- Cuentas bancarias y espacios de efectivo.
- Plan mensual para ingresos y gastos.
- Marcado automático de items del plan al registrarlos.
- Presupuesto mensual real basado en lo que planifican y registran.
- Privacidad separada: cada persona ve solo su espacio personal y ambos ven solo lo compartido.

---

## Configuración de Firebase (paso previo obligatorio)

### 1. Crear proyecto en Firebase

1. Ve a [console.firebase.google.com](https://console.firebase.google.com)
2. Haz clic en **Agregar proyecto** y sigue el asistente.
3. En el menú lateral abre **Firestore Database → Crear base de datos**.
   - Elige **Modo producción** (las reglas de `firestore.rules` bloquean acceso directo desde clientes).
   - Selecciona la región más cercana (p. ej. `us-central1`).

### 2. Obtener credenciales de cuenta de servicio

1. En la consola de Firebase, ve a ⚙️ **Configuración del proyecto → Cuentas de servicio**.
2. Haz clic en **Generar nueva clave privada** → descarga el archivo JSON.

### 3. Configurar variables de entorno

Copia `.env.example` a `.env` y elige **una** de las dos opciones:

**Opción A – Variable de entorno con JSON embebido (recomendada para despliegues)**
```bash
# Pega el contenido del JSON como una sola línea
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"mi-proyecto",...}
```

**Opción B – Archivo JSON local (cómoda en desarrollo)**
```bash
GOOGLE_APPLICATION_CREDENTIALS=/ruta/absoluta/a/serviceAccountKey.json
```

### 4. Desplegar reglas e índices de Firestore

```bash
# Instala Firebase CLI si no lo tienes
npm install -g firebase-tools
firebase login

# Inicializa el proyecto (elige Firestore, usa los archivos existentes)
firebase init firestore

# Despliega reglas e índices compuestos
firebase deploy --only firestore
```

> Los índices compuestos pueden tardar unos minutos en construirse la primera vez.

---

## Instalación y ejecución

```bash
npm install
node server.js
```

Luego abre una de las URLs que imprime el servidor.

---

## Estructura de colecciones en Firestore

| Colección        | Descripción                                         |
|------------------|-----------------------------------------------------|
| `users`          | Datos de usuario (nombre, email, hash de contraseña) |
| `households`     | Hogar compartido (moneda, código de invitación)     |
| `memberships`    | Vínculo usuario ↔ hogar                             |
| `sessions`       | Sesiones activas (cookie `sid`)                     |
| `passwordResets` | Códigos temporales de recuperación                  |
| `accounts`       | Cuentas bancarias y espacios de efectivo            |
| `planTemplates`  | Plantillas de items fijos mensuales                 |
| `planItems`      | Items del plan por mes                              |
| `transactions`   | Movimientos diarios (incluye campo `monthKey`)      |

### Notas clave de implementación actual

- El saldo de cada cuenta se guarda en `currentBalance` y se actualiza **atómicamente** con cada transacción usando `FieldValue.increment`. No hay JOINs de agregación.
- Las transacciones almacenan el campo `monthKey` (ej: `"2025-04"`) para facilitar consultas por mes sin necesidad de `substr()`.
- Las consultas de visibilidad personal/compartida se dividen en **dos queries** paralelas (shared + personal) por limitaciones de Firestore, y se combinan en memoria.

---

## Flujo recomendado

1. La primera persona crea cuenta y hogar.
2. Copia el código de invitación desde Ajustes.
3. La segunda persona se registra usando ese código.
4. Cada quien crea sus cuentas personales y, si quieren, cuentas compartidas.
5. En `Plan`, agregan ingresos y gastos del mes.
6. En `Registro`, guardan los movimientos diarios y vinculan los items del plan para que queden tachados.

---

## Nota sobre PWA en celular

En desarrollo local puedes abrir la app desde la red local usando la IP que imprime el servidor. Para instalarla como PWA con autenticación segura, despliégala por HTTPS (Railway, Render, Fly.io, etc.) y configura `NODE_ENV=production`.

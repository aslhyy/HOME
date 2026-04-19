# Home

App movil web para finanzas en pareja con:

- Registro y login con sesion.
- Base de datos SQLite local.
- Hogar compartido con codigo de invitacion.
- Cuentas bancarias y espacios de efectivo.
- Plan mensual para ingresos y gastos.
- Marcado automatico de items del plan al registrarlos.
- Presupuesto mensual real basado en lo que planifican y registran.
- Privacidad separada: cada persona ve solo su espacio personal y ambos ven solo lo compartido.

## Ejecutar

```powershell
node server.js
```

Luego abre una de las URLs que imprime el servidor.

## Flujo recomendado

1. La primera persona crea cuenta y hogar.
2. Copia el codigo de invitacion desde Ajustes.
3. La segunda persona se registra usando ese codigo.
4. Cada quien crea sus cuentas personales y, si quieren, cuentas compartidas.
5. En `Plan`, agregan ingresos y gastos del mes.
6. En `Registro`, guardan los movimientos diarios y vinculan los items del plan para que queden tachados.

## Archivo de datos

La base se crea automaticamente en:

```text
data/home.sqlite
```

## Nota importante para celular

En desarrollo local puedes abrir la app desde la red local usando la IP que imprime el servidor.
Para instalarla de forma completa como PWA en el celular y usarla diariamente con autenticacion segura, el siguiente paso ideal es desplegarla por HTTPS.

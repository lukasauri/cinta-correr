# CintaPC

App de escritorio para Windows que controla la cinta **Behumax Treadmill Slim 4000** (o cualquier cinta
con Bluetooth FTMS, el protocolo que usa Kinomap) y sube las sesiones a **Garmin Connect** y **Strava**.

## Instalación (solo una vez)

1. Descarga **[Instalar CintaPC.bat](https://github.com/lukasauri/cinta-correr/releases/latest/download/Instalar.CintaPC.bat)**.
2. Haz doble clic en el archivo descargado.
   - Si Windows dice *"Windows protegió su PC"*, pulsa **Más información → Ejecutar de todas formas**.
3. Espera a que termine (la primera vez tarda unos minutos). Aparecerá el icono **CintaPC** en el escritorio.

A partir de ahí, abre siempre la app con el icono **CintaPC**. Cada vez que se abre busca si hay una versión
nueva y, si la hay, la instala sola. Tus entrenamientos, historial, ajustes y cuentas se conservan.
No hace falta instalar nada más ni tener permisos de administrador.

## Primeros pasos

1. Activa el **Bluetooth** de Windows.
2. Enciende la cinta y **cierra Kinomap o desconéctalo** en el móvil: la cinta solo acepta una conexión a la vez.
3. Pulsa **Conectar cinta** → **Buscar cinta Bluetooth** y elige tu cinta en la lista.
   Si no aparece, marca *Mostrar todos los dispositivos*.
4. (Opcional) **Conectar pulsómetro** para la banda o el reloj (en Garmin: activa "Transmitir FC").

## Subida automática a Garmin Connect y Strava

Configúralo en **Ajustes → Garmin Connect y Strava**.

- **Garmin Connect**: pulsa *Iniciar sesión en Garmin* y entra con tu cuenta en la ventana de Garmin
  (también funciona con la verificación en dos pasos). Al terminar cada sesión se genera un archivo
  **.FIT de "Carrera en cinta"** (una vuelta por cada paso del entrenamiento) y se sube solo.
  Es un método **no oficial**: si Garmin lo cambia, puede dejar de funcionar.
  La contraseña no la ve la app; los tokens se guardan cifrados con Windows y se renuevan solos.
- **Strava**: crea tu app en https://www.strava.com/settings/api (Authorization Callback Domain:
  `localhost`), pulsa *Abrir config.env*, pega el Client ID y el Client Secret y pulsa
  *Ya he puesto las claves* → *Conectar con Strava*.
- Con los dos activados, primero se espera a que Garmin pase la actividad a Strava (si tienes las cuentas
  enlazadas). Si no llega en unos 10 minutos, se sube directamente. Si falla algo (sin internet, sesión
  caducada…), la subida se reintenta sola y el estado se ve en el **Historial**.

## Funciones

- **Entrenar**: *Carrera libre* o entrenamientos que cambian la velocidad solos, con pitidos y voz.
  Teclado: `Espacio`/`Esc` pausa, `↑`/`↓` velocidad, `F` pantalla completa.
- **Personalizar**: qué datos se ven, en qué orden y tamaño, columnas, texto, tema y color.
- **Entrenamientos**: pasos por tiempo o distancia y generador de series.
- **Historial**: gráficas, estado de las subidas, TCX y archivo FIT de cada sesión.
- **Simulador**: prueba todo sin la cinta.

## Si algo no funciona

- **La cinta no conecta**: Ajustes → Diagnóstico → *Copiar registro* y envíalo.
- **La app no abre o no se actualiza**: envía el archivo `registro.log` de la carpeta
  `%LOCALAPPDATA%\CintaPC` (pégalo en la barra de direcciones del Explorador de archivos).
- **Reinstalar**: vuelve a ejecutar *Instalar CintaPC.bat*. No borra los datos.

---

## Para desarrollo

Requisitos: Node.js 22.12 o posterior y git.

- `Iniciar CintaPC.cmd`: abre la versión de esta carpeta (instala dependencias si hace falta).
- `npm test`: pruebas del FIT y de la integración con Garmin/Strava (con servidores falsos).
- `F12` en la app abre las herramientas de desarrollo.

### Publicar una versión (para que le llegue a la app instalada)

Los cambios que subes a GitHub **no** llegan a la app instalada hasta que publicas una versión:

```
npm run publicar                         # 0.2.0 -> 0.2.1
npm run publicar -- menor                # 0.2.1 -> 0.3.0
npm run publicar -- 1.0.0 "Qué cambia"   # versión concreta con notas
```

El script comprueba que no hay cambios sin guardar y que las pruebas pasan, cambia la versión, crea el
commit y la etiqueta, lo sube y crea la *release* en GitHub con el instalador adjunto. Necesita
[GitHub CLI](https://cli.github.com/) con sesión iniciada (`gh auth login`).

### Cómo funciona la actualización

- `Instalar CintaPC.bat` descarga un Node.js propio (comprobando su checksum) en
  `%LOCALAPPDATA%\CintaPC\node`, descarga `scripts/lanzar.mjs` y lo ejecuta con `--instalar`.
- `lanzar.mjs` (lo que abre el icono) consulta la última *release* de GitHub. Si es más nueva, descarga
  el código de esa versión, reutiliza las dependencias si no han cambiado (si no, `npm ci`), cambia la
  carpeta `app` por la nueva y abre la app. Si algo falla, se queda la versión anterior.
- Datos de la app: `%APPDATA%\CintaPC` (fuera de la carpeta de la app, así sobreviven a las actualizaciones).

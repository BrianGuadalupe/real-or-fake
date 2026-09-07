# ¿Cámara o IA?

Juego estático de diez rondas para adivinar si un vídeo fue grabado con cámara o generado con inteligencia artificial.

## Añadir vídeos desde Google Drive

1. Sube cada MP4 a una carpeta de Drive dedicada al juego.
2. Usa nombres neutros como `clip-001.mp4`; no pongas `real` o `ia` en el nombre.
3. En cada archivo, abre **Compartir → Acceso general → Cualquier persona con el enlace → Lector**.
4. Copia el enlace de compartir.
5. Edita [`public/clips.json`](public/clips.json), elimina el clip de demostración y añade un objeto por vídeo.

Ejemplo de vídeo grabado:

```json
{
  "id": "clip-001",
  "enabled": true,
  "truth": "camera",
  "media": {
    "provider": "drive",
    "shareUrl": "https://drive.google.com/file/d/ID_DEL_ARCHIVO/view?usp=sharing"
  },
  "provenance": {
    "label": "Grabado con cámara",
    "detail": "Grabado por Nombre en Madrid. Archivo original conservado.",
    "sourceName": "Fuente o autor",
    "sourceUrl": "https://...",
    "license": "Propio / Pexels / CC BY...",
    "date": "2026-09"
  }
}
```

Ejemplo generado con IA:

```json
{
  "id": "clip-002",
  "enabled": true,
  "truth": "ai",
  "media": {
    "provider": "drive",
    "shareUrl": "https://drive.google.com/file/d/ID_DEL_ARCHIVO/view?usp=sharing"
  },
  "provenance": {
    "label": "Generado con IA",
    "detail": "Generación propia; se conserva el prompt y el archivo original.",
    "model": "Proveedor y versión del modelo",
    "license": "Generación propia",
    "date": "2026-09"
  }
}
```

También puedes copiar la plantilla completa de [`public/clips.example.json`](public/clips.example.json).

### Por qué se usa el reproductor de Drive

Los enlaces normales de Google no son URLs directas de vídeo. La aplicación extrae el identificador del enlace y construye el reproductor `/preview` recomendado para contenido insertado. No uses enlaces `uc?export=download` como si Drive fuese una CDN: pueden redirigir, mostrar avisos o bloquearse por exceso de tráfico.

Comprueba siempre cada enlace en una ventana privada antes de publicar. El identificador del archivo será visible para cualquier visitante y Drive puede permitir la descarga.

Si más adelante migras a R2, S3, Cloudinary u otro almacenamiento que entregue MP4 directamente, solo cambia `media`:

```json
"media": {
  "provider": "direct",
  "url": "https://cdn.ejemplo.com/clip-002.mp4",
  "poster": "https://cdn.ejemplo.com/clip-002.jpg"
}
```

## Reglas del catálogo

- `truth` solo acepta `camera` o `ai`.
- Usa identificadores y nombres de archivo que no revelen la respuesta.
- La partida elige hasta diez clips y busca un reparto equilibrado.
- Conserva fuera de la web el original, su hash, el prompt o consentimiento y una copia de la licencia.
- Excluye del juego binario los vídeos parcialmente editados con IA o de procedencia dudosa.
- Al ser una web estática, las respuestas de `clips.json` son visibles para quien inspeccione el código. Es un juego casual, no una competición con premios.

## Desarrollo

```bash
npm run dev
```

Abre `http://localhost:3000`.

Comprobar la versión de producción:

```bash
npm run build
```

## Fuentes técnicas sobre Drive

- [Recomendación de Google para insertar archivos mediante iframe](https://workspaceupdates.googleblog.com/2023/10/upcoming-changes-to-third-party-cookies-in-google-drive.html)
- [Descargas y rangos parciales en Drive API](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Límites de uso de Drive API](https://developers.google.com/workspace/drive/api/guides/limits)


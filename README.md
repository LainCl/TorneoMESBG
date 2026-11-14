# ⚔️ Torneo MESBG — Gestor de Torneos

Aplicación web para la inscripción, emparejamiento suizo y administración de torneos de **Middle-earth Strategy Battle Game (MESBG)**, desarrollada para la **Comunidad MESBG Chile** por **Equipo DeazuL 2026**.

---

## ✨ Características Principales

- **3 Modalidades de Juego:**
  - **Individual (`1 vs 1`)**: Emparejamiento suizo en mesa individual.
  - **Parejas (`2 vs 2`)**: Duelos por parejas con ajuste automático de Puntos de Victoria por abandono (`12 PV`).
  - **Equipos (`Duelos 4vs4`)**: Enfrentamientos por equipos con sorteo de colores (*Rojo / Azul*), asignación de grupos de mesas y volcado automático de cruces individuales.
- **2 Sistemas de Puntuación de Torneo:**
  - **Expandido:** Victoria Masacre (`Dif ≥ 6 PV`: `5 pts`), Victoria Marginal (`4 pts`), Empate (`2 pts`), Derrota Marginal (`1 pt`), Derrota Masacre (`0 pts`), Rendición (`-1 pt`).
  - **Clásico:** Victoria (`3 pts`), Empate (`1 pt`), Derrota (`0 pts`).
- **Gestión de Rondas y Emparejamiento Suizo:**
  - Sorteo aleatorio en Ronda 1 y emparejamiento por escalafón en Rondas 2+ con *backtracking* para **evitar repetir oponentes** y **evitar repetir mesas**.
  - Cálculo automático de penalizaciones por pintura (`-1` o `-2` en equipos) y atraso (`-1`), más validación reglamentaria para atrasos `> 20 min`.
- **Podio Oficial y Exportación Visual:**
  - Ordenamiento multicriterio: `1° No Abandono` • `2° PT Final` • `3° Diferencia de PV` • `4° PV a Favor`.
  - **Animación de Podio Final** con pedestales de Oro, Plata, Bronce, Cuchara de Palo y lluvia de confeti.
  - **Descarga de Imagen de Resultados (`1080 × 1920 px`)** lista para compartir en redes sociales con la tabla completa de posiciones.
- **Persistencia Automática:**
  - Todos los datos se guardan automáticamente en el navegador (`localStorage`) en cada acción.

---

## 🚀 Uso Local

No requiere dependencias externas ni compilación. Puedes abrir `index.html` directamente o levantar un servidor local:

```bash
python -m http.server 8080
```

Luego abre `http://localhost:8080` en tu navegador.

---

## 🌐 Publicación en GitHub Pages

1. Sube este repositorio a GitHub.
2. Ve a **Settings → Pages** en tu repositorio de GitHub.
3. En **Build and deployment (Source)** selecciona **Deploy from a branch** → rama `main` → carpeta `/ (root)` y presiona **Save**.
4. Tu aplicación quedará publicada online lista para usar desde cualquier dispositivo.

---

## 🔗 Enlaces

- **YouTube:** [@DeAzul_boardgames](https://www.youtube.com/@DeAzul_boardgames)
- **Instagram:** [@comunidad_mesbg_cl](https://www.instagram.com/comunidad_mesbg_cl/)

*Creado por **Equipo DeazuL 2026**.*

const FichasEmpaque = (() => {
  const base = new URL(".", document.currentScript.src);
  const dialog = document.getElementById("dialogFichas");
  const el = nombre => document.getElementById("fichas" + nombre);
  const puntosPorMm = 72 / 25.4;
  const ancho = 210 * puntosPorMm;
  const alto = 297 * puntosPorMm;
  let sesion;
  let urlPdf;
  let indicePendiente;
  let archivoPendiente;

  async function cargarArchivo(nombre, formato) {
    const respuesta = await fetch(new URL(nombre, base));
    if (!respuesta.ok) throw new Error("No se encontró " + nombre);
    return respuesta[formato]();
  }

  function cargarIndice() {
    if (!indicePendiente) {
      indicePendiente = cargarArchivo("catalogo.json", "json")
        .catch(error => { indicePendiente = null; throw error; });
    }
    return indicePendiente;
  }

  function cargarCatalogo() {
    if (!archivoPendiente) {
      archivoPendiente = cargarArchivo("catalogo.pdf", "arrayBuffer")
        .catch(error => { archivoPendiente = null; throw error; });
    }
    return archivoPendiente;
  }

  function agruparLineas(lineas, indice) {
    const disponibles = new Map();
    const faltantes = new Set();
    for (const linea of lineas.filter(Boolean)) {
      const sku = String(linea.sku ?? "").trim().toUpperCase();
      const nombre = linea.producto || linea.nombre || "";
      const cantidad = Number(linea.cantidad);
      if (!sku || !Object.hasOwn(indice, sku)) {
        faltantes.add([sku, nombre].filter(Boolean).join(" · ") || "Producto sin SKU");
        continue;
      }
      if (!disponibles.has(sku)) disponibles.set(sku, {sku, nombre, pagina: indice[sku], cantidad: 0});
      if (Number.isSafeInteger(cantidad) && cantidad > 0) disponibles.get(sku).cantidad += cantidad;
    }
    return {disponibles: Array.from(disponibles.values()), faltantes: Array.from(faltantes)};
  }

  function quitarPdf() {
    if (urlPdf) {
      const anterior = urlPdf;
      setTimeout(() => URL.revokeObjectURL(anterior), 60000);
      urlPdf = null;
    }
    for (const elemento of [el("Abrir"), el("Descargar")]) {
      elemento.hidden = true;
      elemento.removeAttribute("href");
    }
  }

  function actualizarResumen() {
    const total = sesion?.filas.reduce((suma, fila) => suma + (fila.input.valueAsNumber || 0), 0) ?? 0;
    const validas = sesion?.filas.every(fila => fila.input.validity.valid);
    const hojas = Math.ceil(total / 4);
    el("Resumen").textContent = validas && total > 0
      ? `${total} ${total === 1 ? "ficha" : "fichas"} en ${hojas} ${hojas === 1 ? "hoja" : "hojas"} A4`
      : "";
    el("Generar").disabled = !validas || !Number.isSafeInteger(total) || total <= 0 || !!sesion?.generando;
  }

  async function abrir(id, cargarLineas) {
    if (dialog.open) return;
    const actual = {id, filas:[], generando:false};
    sesion = actual;
    quitarPdf();
    el("Filas").replaceChildren();
    el("Tabla").hidden = true;
    el("Faltantes").hidden = true;
    el("Titulo").textContent = "Imprimir fichas de empaque · Pedido #" + id;
    el("Estado").textContent = "Cargando productos del pedido…";
    actualizarResumen();
    dialog.showModal();
    try {
      const [lineas, indice] = await Promise.all([cargarLineas(), cargarIndice()]);
      if (sesion !== actual) return;
      const {disponibles, faltantes} = agruparLineas(lineas, indice);
      if (faltantes.length) {
        el("Faltantes").textContent = "Sin ficha disponible: " + faltantes.join("; ");
        el("Faltantes").hidden = false;
      }
      actual.filas = disponibles.map(ficha => {
        const fila = el("Filas").insertRow();
        fila.insertCell().textContent = ficha.sku;
        fila.insertCell().textContent = ficha.nombre || ficha.sku;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.step = "1";
        input.required = true;
        input.value = ficha.cantidad;
        input.setAttribute("aria-label", "Copias de " + (ficha.nombre || ficha.sku) + " (" + ficha.sku + ")");
        fila.insertCell().append(input);
        return {...ficha, input};
      });
      el("Tabla").hidden = !actual.filas.length;
      el("Estado").textContent = actual.filas.length
        ? "Por defecto sale una ficha por unidad. Podés cambiar las copias o poner 0 para omitir un producto."
        : "Este pedido no tiene fichas disponibles para imprimir.";
      actualizarResumen();
    } catch (error) {
      if (sesion !== actual) return;
      el("Estado").textContent = "No se pudieron cargar las fichas. Cerrá y volvé a intentar.";
      console.error(error);
    }
  }

  function dibujarGuias(pagina, rgb) {
    const margen = 7 * puntosPorMm;
    const color = rgb(.59, .65, .70);
    pagina.drawLine({start:{x:ancho/2,y:margen},end:{x:ancho/2,y:alto-margen},thickness:.4,color,dashArray:[3,3]});
    pagina.drawLine({start:{x:margen,y:alto/2},end:{x:ancho-margen,y:alto/2},thickness:.4,color,dashArray:[3,3]});
  }

  async function armarPdf(bytes, fichas, id) {
    const {PDFDocument, PrintScaling, rgb} = globalThis.PDFLib;
    const origen = await PDFDocument.load(bytes);
    const resultado = await PDFDocument.create();
    resultado.setTitle("Fichas de empaque · Pedido #" + id);
    resultado.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);

    const laminas = await resultado.embedPages(fichas.map(ficha => origen.getPage(ficha.pagina)));
    let posicion = 0;
    let hoja;
    for (let i = 0; i < fichas.length; i++) {
      const lamina = laminas[i];
      const escala = Math.min(ancho / 2 / lamina.width, alto / 2 / lamina.height);
      const anchoFicha = lamina.width * escala;
      const altoFicha = lamina.height * escala;
      for (let copia = 0; copia < fichas[i].cantidad; copia++) {
        const cuadro = posicion % 4;
        if (cuadro === 0) {
          hoja = resultado.addPage([ancho, alto]);
          dibujarGuias(hoja, rgb);
        }
        const x = (cuadro % 2) * ancho / 2 + (ancho / 2 - anchoFicha) / 2;
        const y = (cuadro < 2 ? alto / 2 : 0) + (alto / 2 - altoFicha) / 2;
        hoja.drawPage(lamina,{x,y,width:anchoFicha,height:altoFicha});
        posicion++;
      }
    }
    return resultado.save();
  }

  el("Formulario").addEventListener("input", () => {
    quitarPdf();
    if (sesion?.filas.length) el("Estado").textContent = "Revisá las cantidades y generá el PDF.";
    actualizarResumen();
  });
  el("Formulario").addEventListener("submit", async evento => {
    evento.preventDefault();
    if (el("Generar").disabled || !sesion || sesion.generando) return;
    const actual = sesion;
    const fichas = actual.filas.map(({pagina,input}) => ({pagina,cantidad:input.valueAsNumber}))
      .filter(ficha => ficha.cantidad > 0);
    actual.generando = true;
    for (const fila of actual.filas) fila.input.disabled = true;
    actualizarResumen();
    quitarPdf();
    el("Estado").textContent = "Generando PDF…";
    try {
      const bytes = await cargarCatalogo();
      if (sesion !== actual) return;
      const pdf = await armarPdf(bytes, fichas, actual.id);
      if (sesion !== actual) return;
      urlPdf = URL.createObjectURL(new Blob([pdf], {type:"application/pdf"}));
      el("Abrir").href = urlPdf;
      el("Descargar").href = urlPdf;
      el("Descargar").download = "Fichas_pedido_" + String(actual.id).replace(/[^\w-]/g,"_") + ".pdf";
      el("Abrir").hidden = el("Descargar").hidden = false;
      el("Estado").textContent = "PDF listo. Imprimí en A4 vertical a tamaño real (100 %).";
      el("Abrir").focus();
    } catch (error) {
      if (sesion !== actual) return;
      el("Estado").textContent = "No se pudo generar el PDF. Volvé a intentar.";
      console.error(error);
    } finally {
      if (sesion === actual) {
        actual.generando = false;
        for (const fila of actual.filas) fila.input.disabled = false;
        actualizarResumen();
      }
    }
  });
  el("Cerrar").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    sesion = null;
    quitarPdf();
  });
  return {abrir};
})();

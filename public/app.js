(() => {
  "use strict";

  // ---- Configuration (à modifier ici) ----
  const EVENT = {
    name: "Inauguration NTMC",
    meta: "10 décembre 2026 · Boubéné Dargol",
    code: "NTMC",
  };

  // Règles par profil : nombre max d'accompagnants et zones autorisées
  const PROFILS = {
    officiel:    { label: "Autorité ou officiel", maxAccompagnants: 3 },
    presse:      { label: "Presse",               maxAccompagnants: 0 },
    invite:      { label: "Invité",               maxAccompagnants: 0 },
    prestataire: { label: "Prestataire",          maxAccompagnants: 0 },
    personnel:   { label: "Personnel",            maxAccompagnants: 0 },
  };

  const DRAFT_KEY = "usine_brouillon_v1";
  const REG_KEY = "usine_demandes_v1";
  const TOTAL = 5;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const form = document.getElementById("form");
  const steps = [...document.querySelectorAll(".step")];
  const labels = [...document.querySelectorAll("#steps li")];
  const prevBtn = document.getElementById("prev");
  const nextBtn = document.getElementById("next");
  const fill = document.getElementById("progress-fill");
  const progressBar = document.querySelector(".progress");
  let current = 1;

  // Le titre, la date et le lieu sont écrits dans index.html (repris de l'affiche).
  document.getElementById("badge-event").textContent = EVENT.name;

  if (new URLSearchParams(location.search).has("admin")) {
    document.getElementById("export").hidden = false;
  }

  // ---- Logique conditionnelle ----
  function applyConditions() {
    document.querySelectorAll("[data-show-if]").forEach((block) => {
      const [name, values] = block.dataset.showIf.split(":");
      const field = form.elements[name];
      const val = field ? field.value : "";
      const show = values.split("|").includes(val);
      block.hidden = !show;
      block.querySelectorAll("input, select, textarea").forEach((el) => (el.disabled = !show));
    });
    // Nombre d'accompagnants borné selon le profil
    const p = PROFILS[form.elements.type.value];
    const acc = form.elements.accompagnants;
    if (p && acc) acc.max = p.maxAccompagnants;
  }

  // ---- Brouillon automatique ----
  function saveDraft() {
    const state = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox" || el.type === "radio") state[el.name + "|" + el.value] = el.checked;
      else state[el.name] = el.value;
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(state)); } catch {}
  }

  function restoreDraft() {
    let state;
    try { state = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch { return; }
    if (!state) return;
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === "checkbox" || el.type === "radio") el.checked = !!state[el.name + "|" + el.value];
      else if (state[el.name] !== undefined) el.value = state[el.name];
    }
  }

  // ---- Validation ----
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const PHONE_RE = /^\+?[0-9 ()-]{8,20}$/;
  const PLAQUE_RE = /^[A-Z0-9][A-Z0-9 -]{3,14}$/;

  function fieldError(el) {
    if (el.disabled) return "";
    if (el.type === "checkbox" && el.name === "consent") {
      return el.checked ? "" : "Ce consentement est obligatoire.";
    }
    if (el.type === "radio" || el.type === "checkbox" || el.type === "file") return "";
    const v = el.value.trim();
    if (el.name === "photo" && !v) return "Ajoutez votre photo pour le badge.";
    if (el.name === "geo_lat" && !v) return "Activez la localisation pour continuer.";
    if (el.required && !v) return "Ce champ est obligatoire.";
    if (!v) return "";
    if (el.type === "email" && !EMAIL_RE.test(v)) return "Adresse e-mail invalide.";
    if (el.name === "email_confirm" && v !== form.elements.email.value.trim()) {
      return "Les adresses ne correspondent pas.";
    }
    if (el.type === "tel" && !PHONE_RE.test(v)) return "Numéro invalide, exemple : +227 00 00 00 00.";
    if (el.name === "plaque" && !PLAQUE_RE.test(v.toUpperCase())) return "Immatriculation invalide.";
    if (el.name === "passagers") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) return "Au moins 1 personne (le conducteur).";
      if (n > 3) return "3 personnes maximum par véhicule.";
      return "";
    }
    if (el.type === "number") {
      const n = Number(v);
      const max = Number(el.max);
      if (!Number.isInteger(n) || n < 0) return "Indiquez un nombre entier.";
      if (n > max) return `Ce profil permet au maximum ${max} accompagnant${max > 1 ? "s" : ""}.`;
    }
    return "";
  }

  function setError(container, msg) {
    if (!container) return;
    const box = container.querySelector(":scope > .error");
    container.classList.toggle("is-invalid", !!msg);
    if (box) box.textContent = msg;
  }

  function shake(container) {
    if (!container || reduceMotion) return;
    container.classList.remove("shake");
    void container.offsetWidth;
    container.classList.add("shake");
  }

  function validateStep(n) {
    const section = steps[n - 1];
    let firstBad = null;

    // Un seul message par bloc .field (certains blocs ont plusieurs entrées)
    const errs = new Map();
    section.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.closest("[data-group-required]")) return;
      const msg = fieldError(el);
      const container = el.closest(".field");
      if (!errs.get(container)) errs.set(container, msg);
      if (msg && !firstBad) firstBad = container || el;
    });
    errs.forEach((msg, container) => setError(container, msg));

    section.querySelectorAll("[data-group-required]").forEach((group) => {
      if (group.closest("[hidden]")) return;
      const ok = !!group.querySelector("input:checked");
      const msg = ok ? "" : "Choisissez au moins une option.";
      setError(group, msg);
      if (msg && !firstBad) firstBad = group;
    });

    // Le consentement vit dans un .field à l'étape 5 : déjà couvert ci-dessus
    if (firstBad) {
      shake(firstBad);
      firstBad.querySelector("input, select, textarea")?.focus?.({ preventScroll: true });
    }
    return !firstBad;
  }

  form.addEventListener("input", onFieldChange);
  form.addEventListener("change", onFieldChange);
  function onFieldChange(e) {
    applyConditions();
    const el = e.target;
    const group = el.closest("[data-group-required]");
    if (group && group.classList.contains("is-invalid")) {
      setError(group, group.querySelector("input:checked") ? "" : "Choisissez au moins une option.");
    }
    const container = el.closest(".field");
    if (container && container.classList.contains("is-invalid") && !group) {
      setError(container, fieldError(el));
    }
    if (el.name === "plaque") el.value = el.value.toUpperCase();
    saveDraft();
  }

  // ---- Navigation ----
  function show(n) {
    const update = () => {
      steps.forEach((s) => s.classList.toggle("is-active", +s.dataset.step === n));
      labels.forEach((li, i) => {
        li.classList.toggle("is-current", i + 1 === n);
        li.classList.toggle("is-done", i + 1 < n);
      });
      fill.style.width = ((n - 1) / (TOTAL - 1)) * 100 + "%";
      progressBar.setAttribute("aria-valuenow", String(n));
      prevBtn.hidden = n === 1;
      nextBtn.textContent = n === TOTAL ? "Envoyer la demande" : "Continuer";
      nextBtn.type = n === TOTAL ? "submit" : "button";
      current = n;
      if (n === TOTAL) renderSummary();
      steps[n - 1].querySelector("input:not(:disabled):not([type=hidden]):not([type=file]):not([type=radio]), select:not(:disabled), textarea")?.focus({ preventScroll: true });
    };
    update();
  }

  nextBtn.addEventListener("click", () => {
    if (validateStep(current)) show(Math.min(current + 1, TOTAL));
  });
  prevBtn.addEventListener("click", () => show(Math.max(current - 1, 1)));

  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName !== "TEXTAREA" && current < TOTAL) {
      e.preventDefault();
      nextBtn.click();
    }
  });

  // ---- Récapitulatif ----
  const val = (name) => {
    const el = form.elements[name];
    if (!el || el.disabled) return "";
    if (el.tagName === "SELECT") return el.selectedOptions[0]?.text || "";
    return (el.value || "").trim();
  };
  const checked = (name) =>
    [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.parentElement.textContent.trim());

  function collect() {
    const type = val("type");
    return {
      type,
      type_label: PROFILS[type]?.label || "",
      acces: val("acces"),
      plaque: val("plaque").toUpperCase(),
      transport_type: val("transport_type"),
      passagers: val("passagers"),
      geo_lat: val("geo_lat"),
      geo_lng: val("geo_lng"),
      geo_acc: val("geo_acc"),
      photo: val("photo"),
      civilite: val("civilite"),
      prenom: val("prenom"),
      nom: val("nom"),
      telephone: val("telephone"),
      email: val("email"),
      organisation: val("organisation"),
      fonction: val("fonction"),
      ref_contrat: val("ref_contrat"),
      carte_presse: val("carte_presse"),
      accompagnants: val("accompagnants") || "0",
      matricule: val("matricule"),
      zones: [...checked("zones"), ...checked("zones_tech")].join(", "),
      demande: val("demande"),
    };
  }

  function renderSummary() {
    const d = collect();
    const rattachement =
      d.ref_contrat ? "Contrat " + d.ref_contrat :
      d.carte_presse ? "Carte de presse " + d.carte_presse :
      d.matricule ? "Matricule " + d.matricule :
      d.type === "officiel" ? d.accompagnants + " accompagnant(s)" : "";
    const rows = [
      ["Profil", d.type_label],
      ["Accès", d.acces === "vehicule" ? `Véhicule personnel · ${d.plaque} · ${d.passagers} personne${d.passagers > 1 ? "s" : ""} à bord` : `Transport en commun · ${d.transport_type}`],
      ["Localisation", d.geo_lat ? `${fmtCoords(d.geo_lat, d.geo_lng)} · ±${d.geo_acc} m` : ""],
      ["Photo", d.photo ? "Ajoutée" : "", d.photo],
      ["Nom", `${d.civilite} ${d.prenom} ${d.nom}`.trim()],
      ["Contact", `${d.telephone} · ${d.email}`],
      ["Rattachement", `${d.organisation} · ${d.fonction}${rattachement ? " · " + rattachement : ""}`],
      ["Zones", d.zones],
    ];
    const dl = document.getElementById("summary");
    dl.replaceChildren(
      ...rows.flatMap(([k, v, img]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        if (img) {
          const im = document.createElement("img");
          im.src = img;
          im.alt = "Photo";
          im.className = "summary-photo";
          dd.append(im);
        } else {
          dd.textContent = v || "—";
        }
        return [dt, dd];
      })
    );
  }

  // ---- Soumission ----
  function newId() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.getRandomValues(new Uint32Array(6));
    let s = "";
    for (const b of bytes) s += alphabet[b % alphabet.length];
    return `${EVENT.code}-${s}`;
  }

  function loadRegs() {
    try { return JSON.parse(localStorage.getItem(REG_KEY) || "[]"); } catch { return []; }
  }

  // Serveur de suivi disponible ? (lancé avec serve.ps1)
  let API = null;
  fetch("/api/info", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => { API = j; })
    .catch(() => {});

  function duplicateError(msg) {
    setError(form.elements.telephone.closest(".field"), msg || "Une demande existe déjà avec ce numéro ou cet e-mail.");
    show(2);
    form.elements.telephone.focus();
  }

  let sending = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    for (let i = 1; i < TOTAL; i++) {
      if (!validateStep(i)) { show(i); return; }
    }
    if (!validateStep(TOTAL)) return;

    const data = collect();
    let reg;

    if (API) {
      // Mode serveur : l'inscription est centralisée et reçoit un lien de suivi personnel
      sending = true;
      nextBtn.classList.add("is-loading");
      nextBtn.textContent = "Envoi en cours…";
      try {
        const r = await fetch("/api/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: EVENT.code, data }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.status === 409) { duplicateError(j.error); return; }
        if (!r.ok) throw new Error(j.error || "Erreur serveur");
        reg = { id: j.id, createdAt: j.createdAt, trackUrl: j.trackUrl, data };
      } catch {
        const box = form.elements.consent.closest(".field");
        setError(box, "Impossible de joindre le serveur. Vérifiez que serve.ps1 tourne, puis réessayez.");
        shake(box);
        return;
      } finally {
        sending = false;
        nextBtn.classList.remove("is-loading");
        if (current === TOTAL) nextBtn.textContent = "Envoyer la demande";
      }
    } else {
      // Mode hors serveur : enregistrement dans ce navigateur uniquement
      const regs = loadRegs();
      if (regs.some((r) => r.data.telephone === data.telephone || r.data.email === data.email)) {
        duplicateError();
        return;
      }
      reg = { id: newId(), createdAt: new Date().toISOString(), data };
      regs.push(reg);
      try { localStorage.setItem(REG_KEY, JSON.stringify(regs)); } catch {}
    }

    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    showBadge(reg);
  });

  function showBadge(reg) {
    const finish = () => {
      form.hidden = true;
      document.querySelector(".steps").hidden = true;
      progressBar.hidden = true;
      document.getElementById("badge-view").hidden = false;
      document.getElementById("badge-name").textContent = `${reg.data.prenom} ${reg.data.nom}`;
      document.getElementById("badge-type").textContent = reg.data.type_label;
      document.getElementById("badge-id").textContent = reg.id;
      const bp = document.getElementById("badge-photo");
      bp.src = reg.data.photo || "";
      bp.parentElement.hidden = !reg.data.photo;

      // QR : lien de suivi en direct (mode serveur), sinon identifiant + position d'inscription
      const { geo_lat: lat, geo_lng: lng, geo_acc: acc } = reg.data;
      const qrText = reg.trackUrl
        ? reg.trackUrl
        : lat
          ? `${reg.id}\nGEO:${lat},${lng}\nPRECISION:${acc}m\nDATE:${reg.createdAt}`
          : reg.id;
      const qr = document.getElementById("qr");
      qr.replaceChildren();
      if (window.QRCode) {
        // Généré en grand puis réduit par le CSS : net à l'écran comme à l'impression
        new QRCode(qr, { text: qrText, width: 512, height: 512, correctLevel: QRCode.CorrectLevel.M });
      } else {
        qr.textContent = reg.id;
      }

      // Inscription faite sur le téléphone qui sera suivi : on y garde déjà la page de suivi
      // et les infos du badge, pour que le scan ouvre la page instantanément, même sans réseau.
      if (reg.trackUrl) {
        try {
          const u = new URL(reg.trackUrl);
          if (u.origin === location.origin) {
            const { prenom, nom, type_label, organisation, photo } = reg.data;
            try { localStorage.setItem(`suivi_badge_${reg.id}`, JSON.stringify({ id: reg.id, prenom, nom, type_label, organisation, photo })); } catch {}
            try { localStorage.setItem("suivi_dernier", JSON.stringify({ b: reg.id, t: u.searchParams.get("t") })); } catch {}
            if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
          }
        } catch {}
      }

      // Lien de suivi (mode serveur) ou position d'inscription
      const link = document.getElementById("geo-link");
      const hint = document.querySelector(".badge-view .hint");
      link.hidden = !lat && !reg.trackUrl;
      if (reg.trackUrl) {
        link.href = reg.trackUrl;
        link.textContent = "Activer le suivi sur ce téléphone";
        hint.textContent = "Le jour de l'événement, scannez ce QR code avec votre téléphone, appuyez sur « Démarrer » et gardez la page ouverte : votre position sera partagée avec l'organisation.";
      } else if (lat) {
        link.href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;
        link.textContent = `Position d'inscription : ${fmtCoords(lat, lng)}`;
      }
      window.scrollTo({ top: 0 });
    };
    finish();
  }

  document.getElementById("print").addEventListener("click", () => window.print());

  // ---- Export organisateur ----
  document.getElementById("export").addEventListener("click", () => {
    const cols = ["id", "createdAt", "type_label", "acces", "plaque", "passagers", "transport_type", "geo_lat", "geo_lng", "geo_acc", "civilite", "prenom", "nom", "telephone", "email", "organisation", "fonction", "accompagnants", "zones"];
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [cols.join(",")];
    for (const r of loadRegs()) {
      lines.push(cols.map((c) => esc(c === "id" || c === "createdAt" ? r[c] : r.data[c])).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `demandes-${EVENT.code}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---- Photo ----
  const photoField = form.elements.photo;
  const photoFile = document.getElementById("photo_file");
  const photoImg = document.getElementById("photo-img");
  const dropzone = document.getElementById("dropzone");

  function renderPhoto() {
    const v = photoField.value;
    photoImg.hidden = !v;
    if (v) photoImg.src = v;
    else photoImg.removeAttribute("src");
    dropzone.classList.toggle("has-photo", !!v);
    document.getElementById("dz-title").textContent = v ? "Photo ajoutée · changer" : "Ajouter une photo";
  }

  function loadPhoto(file) {
    const box = photoField.closest(".field");
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError(box, "Choisissez une image (JPG, PNG, WebP)."); shake(box); return; }
    if (file.size > 15 * 1024 * 1024) { setError(box, "Image trop lourde (15 Mo maximum)."); shake(box); return; }
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      // Recadrage carré, légèrement vers le haut pour garder le visage, réduit à 360 px
      const size = 360;
      const side = Math.min(im.naturalWidth, im.naturalHeight);
      const sx = (im.naturalWidth - side) / 2;
      const sy = (im.naturalHeight - side) * 0.3;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      c.getContext("2d").drawImage(im, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      photoField.value = c.toDataURL("image/jpeg", 0.85);
      renderPhoto();
      photoField.dispatchEvent(new Event("input", { bubbles: true }));
    };
    im.onerror = () => { URL.revokeObjectURL(url); setError(box, "Impossible de lire cette image."); };
    im.src = url;
  }

  photoFile.addEventListener("change", () => { loadPhoto(photoFile.files[0]); photoFile.value = ""; });
  ["dragenter", "dragover"].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add("is-drag"); }));
  ["dragleave", "drop"].forEach((t) => dropzone.addEventListener(t, () => dropzone.classList.remove("is-drag")));
  dropzone.addEventListener("drop", (e) => { e.preventDefault(); loadPhoto(e.dataTransfer.files[0]); });

  // ---- Géolocalisation ----
  const geoBtn = document.getElementById("geo-btn");
  const geoTitle = document.getElementById("geo-title");
  const geoSub = document.getElementById("geo-sub");
  const geoField = form.elements.geo_lat.closest(".field");

  function fmtCoords(lat, lng) {
    const la = Number(lat), lo = Number(lng);
    return `${Math.abs(la).toFixed(5)}° ${la >= 0 ? "N" : "S"}, ${Math.abs(lo).toFixed(5)}° ${lo >= 0 ? "E" : "O"}`;
  }

  function renderGeo() {
    const lat = form.elements.geo_lat.value;
    geoBtn.classList.toggle("is-on", !!lat);
    geoBtn.setAttribute("aria-pressed", String(!!lat));
    geoTitle.textContent = lat ? "Localisation activée" : "Activer la localisation";
    geoSub.textContent = lat
      ? `${fmtCoords(lat, form.elements.geo_lng.value)} · précision ±${form.elements.geo_acc.value} m`
      : "Nécessaire pour le suivi d'accès le jour de l'événement";
  }

  function geoFail(msg) {
    geoBtn.classList.remove("is-loading");
    setError(geoField, msg);
    shake(geoField);
  }

  geoBtn.addEventListener("click", () => {
    if (!window.isSecureContext) return geoFail("Ouvrez la page via http://localhost:5500 pour activer la localisation.");
    if (!("geolocation" in navigator)) return geoFail("Ce navigateur ne permet pas la localisation.");
    geoBtn.classList.add("is-loading");
    geoTitle.textContent = "Recherche de votre position…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        form.elements.geo_lat.value = latitude.toFixed(6);
        form.elements.geo_lng.value = longitude.toFixed(6);
        form.elements.geo_acc.value = String(Math.round(accuracy));
        geoBtn.classList.remove("is-loading");
        renderGeo();
        setError(geoField, "");
        form.elements.geo_lat.dispatchEvent(new Event("input", { bubbles: true }));
      },
      (err) => {
        renderGeo();
        geoFail(
          err.code === 1 ? "Accès refusé. Autorisez la localisation (icône à gauche de l'adresse), puis réessayez." :
          err.code === 3 ? "Délai dépassé. Réessayez." :
          "Position indisponible. Vérifiez que la localisation de l'appareil est activée."
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });

  // ---- Compteur − / + (personnes à bord) ----
  function initSteppers() {
    document.querySelectorAll(".stepper").forEach((st) => {
      const input = st.querySelector("input");
      const sync = () => {
        const v = Number(input.value) || 0;
        st.dataset.count = String(v);
        st.querySelectorAll(".st-btn").forEach((b) => {
          b.disabled = Number(b.dataset.delta) < 0 ? v <= Number(input.min) : v >= Number(input.max);
        });
      };
      st.addEventListener("click", (e) => {
        const b = e.target.closest(".st-btn");
        if (!b || b.disabled) return;
        const v = Math.min(Number(input.max), Math.max(Number(input.min), (Number(input.value) || 0) + Number(b.dataset.delta)));
        input.value = String(v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        st.classList.remove("bump"); void st.offsetWidth; st.classList.add("bump");
      });
      input.addEventListener("input", sync);
      sync();
    });
  }

  // ---- Démarrage ----
  restoreDraft();
  initSteppers();
  renderPhoto();
  renderGeo();
  applyConditions();
  show(1);
})();

/**
 * Stammdaten und Simulationsdaten.
 *
 * ACHTUNG: Alle Artikel, Marken, Personen und Bons sind FIKTIV und als Simulation
 * gekennzeichnet. Die EANs nutzen den internen Praefix 200 und sind nicht
 * einem Hersteller zugeordnet. Steuersaetze und Preise sind Beispielwerte.
 */
(function (root) {
  const POS = (root.POS = root.POS || {});
  const E = POS.Ean;

  const SCHEMA_VERSION = 3;

  const CATEGORIES = [
    { id: 'MINERAL', name: 'Mineralwasser' },
    { id: 'COLA', name: 'Cola' },
    { id: 'LIMO', name: 'Limonade' },
    { id: 'EISTEE', name: 'Eistee' },
    { id: 'SAFT', name: 'Fruchtsäfte' },
    { id: 'SCHORLE', name: 'Schorlen' },
    { id: 'ENERGY', name: 'Energydrinks' },
    { id: 'BIER', name: 'Bier' },
    { id: 'ALKFREI', name: 'Alkoholfreies Bier' },
    { id: 'WEIN', name: 'Wein' },
    { id: 'SEKT', name: 'Sekt' },
    { id: 'SPIRI', name: 'Spirituosen' },
    { id: 'KISTEN', name: 'Getränkekisten' },
    { id: 'SIXPACK', name: 'Sixpacks' },
    { id: 'SNACKS', name: 'Snacks' },
    { id: 'ZUBEH', name: 'Zubehör' },
  ];

  const DEPOSITS = [
    { id: 'EW25', name: 'Einwegpfand (Dose/PET)', cents: 25, kind: 'EINWEG' },
    { id: 'MW08', name: 'Mehrwegpfand (Flasche)', cents: 8, kind: 'MEHRWEG' },
    { id: 'MW15', name: 'Mehrwegpfand (Glas)', cents: 15, kind: 'MEHRWEG' },
    { id: 'KASTEN', name: 'Kastenpfand', cents: 150, kind: 'KASTEN' },
  ];

  const STAFF = [
    { id: 'U001', nr: '1001', name: 'Anna Beispiel (Sim)', pin: '1111', role: 'KASSIERER', active: true },
    { id: 'U002', nr: '2001', name: 'Bernd Probe (Sim)', pin: '2222', role: 'SCHICHTLEITUNG', active: true },
    { id: 'U003', nr: '9001', name: 'Marktleitung (Sim)', pin: '9999', role: 'ADMIN', active: true },
  ];

  /** Produktfamilien. Jede Kombination Marke x Groesse x Packung ergibt einen Artikel. */
  const SPEC = [
    { cat: 'MINERAL', prod: 'Mineralwasser', vat: 19, brands: ['Waldquell', 'Bergfrisch', 'Talperle', 'Heidequell', 'Nordborn', 'Sonnenquelle', 'Felsenbrunn', 'Auenklar'],
      sizes: [
        { g: '0,5 l Glas', dep: 'MW08', unit: 59, packs: [1, 12], kasten: true },
        { g: '0,75 l Glas', dep: 'MW08', unit: 79, packs: [1, 6], kasten: true },
        { g: '1,5 l PET', dep: 'EW25', unit: 129, packs: [1, 6] },
      ] },
    { cat: 'COLA', prod: 'Cola', vat: 19, brands: ['Kolaquell', 'Rotfunk', 'Brauna', 'Schwarzkap'],
      sizes: [
        { g: '0,5 l PET', dep: 'EW25', unit: 109, packs: [1, 6] },
        { g: '1,0 l Glas', dep: 'MW15', unit: 169, packs: [1, 6], kasten: true },
      ] },
    { cat: 'LIMO', prod: 'Limonade', vat: 19, brands: ['Zitrusheim', 'Fruchtlust', 'Limonalis', 'Sommerhain', 'Beerenlust', 'Apfelgold'],
      sizes: [
        { g: '0,5 l PET', dep: 'EW25', unit: 89, packs: [1, 6] },
        { g: '0,33 l Glas', dep: 'MW08', unit: 79, packs: [1, 12], kasten: true },
      ] },
    { cat: 'EISTEE', prod: 'Eistee', vat: 19, brands: ['Teehain', 'Zitronenblatt', 'Pfirsichsee', 'Grünfeld'],
      sizes: [
        { g: '0,5 l PET', dep: 'EW25', unit: 99, packs: [1, 6] },
        { g: '1,0 l PET', dep: 'EW25', unit: 149, packs: [1, 6] },
      ] },
    { cat: 'SAFT', prod: 'Fruchtsaft', vat: 19, brands: ['Obstgarten', 'Streuobst Nord', 'Apfelhof', 'Traubenhain', 'Orangental', 'Johannisfeld'],
      sizes: [
        { g: '0,2 l Tetra', dep: null, unit: 49, packs: [1, 10] },
        { g: '1,0 l Glas', dep: 'MW15', unit: 199, packs: [1, 6], kasten: true },
      ] },
    { cat: 'SCHORLE', prod: 'Schorle', vat: 19, brands: ['Apfelsonne', 'Traubenfels', 'Kirschwald', 'Holunderau'],
      sizes: [
        { g: '0,5 l PET', dep: 'EW25', unit: 89, packs: [1, 6] },
        { g: '0,7 l Glas', dep: 'MW08', unit: 99, packs: [1, 12], kasten: true },
      ] },
    { cat: 'ENERGY', prod: 'Energydrink', vat: 19, brands: ['Turbohain', 'Wachmacher', 'Feuerquell', 'Blitzbox'],
      sizes: [
        { g: '0,25 l Dose', dep: 'EW25', unit: 129, packs: [1, 4] },
        { g: '0,5 l Dose', dep: 'EW25', unit: 179, packs: [1, 6] },
      ] },
    { cat: 'BIER', prod: 'Pilsener', vat: 19, age: 16, brands: ['Hopfenhof', 'Gerstenwald', 'Malzmeister', 'Fassstolz', 'Braukunst', 'Hellwerk'],
      sizes: [
        { g: '0,5 l Glas', dep: 'MW08', unit: 119, packs: [1, 20], kasten: true },
        { g: '0,33 l Glas', dep: 'MW08', unit: 109, packs: [1, 20], kasten: true },
      ] },
    { cat: 'ALKFREI', prod: 'Alkoholfreies Bier', vat: 19, age: 0, brands: ['Nullprozent', 'Leichtmalz', 'Frischhopf'],
      sizes: [
        { g: '0,33 l Glas', dep: 'MW08', unit: 99, packs: [1, 20], kasten: true },
        { g: '0,5 l Glas', dep: 'MW08', unit: 109, packs: [1, 20], kasten: true },
      ] },
    { cat: 'WEIN', prod: 'Wein', vat: 19, age: 16, brands: ['Rebengold', 'Schieferhang', 'Sonnenhügel', 'Traubenkraft', 'Lagenstolz', 'Weinbergblick', 'Kellerstern', 'Rotlichtgut'],
      sizes: [{ g: '0,75 l Flasche', dep: null, unit: 599, packs: [1, 6] }] },
    { cat: 'SEKT', prod: 'Sekt', vat: 19, age: 16, brands: ['Perlfeld', 'Prickelhain', 'Festtag', 'Sektkeller'],
      sizes: [{ g: '0,75 l Flasche', dep: null, unit: 899, packs: [1, 6] }] },
    { cat: 'SPIRI', prod: 'Spirituose', vat: 19, age: 18, brands: ['Kornbrand Sim', 'Wacholderhof', 'Rumfieber', 'Whiskystolz', 'Kräuterturm', 'Likörhaus'],
      sizes: [{ g: '0,7 l Flasche', dep: null, unit: 1499, packs: [1, 6] }] },
    { cat: 'KISTEN', prod: 'Kiste', vat: 19, brands: ['Waldquell', 'Bergfrisch', 'Rotfunk', 'Hopfenhof', 'Obstgarten'],
      sizes: [
        { g: '0,5 l Glas', dep: 'MW08', unit: 59, packs: [20], kasten: true },
        { g: '0,33 l Glas', dep: 'MW08', unit: 49, packs: [24], kasten: true },
      ] },
    { cat: 'SIXPACK', prod: 'Sixpack', vat: 19, brands: ['Hopfenhof', 'Gerstenwald', 'Malzmeister', 'Fassstolz', 'Cola-Rot Sim', 'Limonalis'],
      sizes: [
        { g: '0,5 l Dose', dep: 'EW25', unit: 99, packs: [6] },
        { g: '0,33 l Glas', dep: 'MW08', unit: 89, packs: [6] },
      ] },
  ];

  const SNACKS = [
    ['Kartoffelchips Paprika 150 g', 129], ['Kartoffelchips Salz 150 g', 129], ['Salzstangen 200 g', 99],
    ['Erdnüsse gesalzen 250 g', 219], ['Erdnussflips 125 g', 169], ['Schokoriegel Karamell 50 g', 89],
    ['Schokoriegel Nougat 50 g', 89], ['Butterkekse 200 g', 199], ['Salzbrezeln 150 g', 119],
    ['Studentenfutter 200 g', 249], ['Müsliriegel Frucht 35 g', 79], ['Gummibärchen 200 g', 149],
    ['Lakritzstangen 150 g', 129], ['Popcorn Butter 90 g', 139], ['Tortillachips Chili 170 g', 189],
    ['Waffelröllchen Kakao 100 g', 119], ['Knabbermix 250 g', 199], ['Crackersnack Sesam 150 g', 139],
    ['Mini-Frikadellen 6 Stück', 399], ['Pommes-Snack Tüte 180 g', 159],
  ];

  const ACCESSORIES = [
    ['Flaschenöffner Edelstahl', 99], ['Trinkhalme 100 Stück', 199], ['Kühltasche 15 l', 1299],
    ['Kronkorken 100 Stück', 299], ['Eiswürfelformen 2 Stück', 499], ['Sektglas 0,2 l Set 6 Stück', 1499],
    ['Bierglas 0,3 l Set 4 Stück', 1199], ['Weinglas 0,35 l Set 2 Stück', 999],
    ['Kohlensäure-Tauschzylinder 600 g', 2499], ['Korkenzieher Hebel', 899],
    ['Kühlakku 300 g', 349], ['Getränketräger Kunststoff', 699],
  ];

  /** Packungsbezeichnung und Pfand je Packung. */
  function packInfo(n, size) {
    if (n === 1) return { label: '', pfand: [{ depositId: size.dep, qty: 1 }].filter((p) => p.depositId) };
    const pfand = size.dep ? [{ depositId: size.dep, qty: n }] : [];
    if (size.kasten) pfand.push({ depositId: 'KASTEN', qty: 1 });
    const label = size.kasten ? `Kiste ${n}` : `Träger ${n}`;
    return { label, pfand };
  }

  /** Endpreis auf ...9 Cent runden (Preisendung 9). */
  function endPrice(cents) {
    return Math.max(99, Math.round(cents / 10) * 10 - 1);
  }

  function buildArticles() {
    const out = [];
    let seq = 0;
    let stockSeed = 42;
    // Deterministischer Pseudo-Zufall (LCG), damit jeder Start identische Testbestaende hat
    const nextStock = () => {
      stockSeed = (Math.imul(stockSeed, 1103515245) + 12345) & 0x7fffffff;
      return stockSeed;
    };
    const add = (a) => {
      seq += 1;
      const r = nextStock();
      const low = r % 11 === 0; // rund 9 % der Artikel starten unter dem Mindestbestand
      out.push({
        id: 'A' + String(seq).padStart(4, '0'),
        plu: String(1000 + seq),
        ean: E.simulationEan13('200', seq),
        simulation: true,
        ...a,
        stock: low ? 2 : 15 + (r % 60),
        minStock: 5 + (r % 8),
        active: true,
      });
    };

    for (const spec of SPEC) {
      spec.brands.forEach((brand, bi) => {
        for (const size of spec.sizes) {
          for (const n of size.packs) {
            const info = packInfo(n, size);
            const unitBase = size.unit + (bi % 4) * 5;
            const priceCents = n === 1 ? unitBase : endPrice(unitBase * n * 0.85);
            const suffix = info.label ? ` ${info.label}` : '';
            add({
              name: `${brand} ${spec.prod} ${size.g}${suffix}`,
              brand,
              category: spec.cat,
              gebinde: size.g,
              packUnit: n === 1 ? 'Einzel' : info.label,
              priceCents,
              vat: spec.vat,
              pfand: info.pfand,
              ageCheck: spec.age || 0,
            });
          }
        }
      });
    }
    SNACKS.forEach(([name, cents]) =>
      add({ name, brand: 'Simulation Snack', category: 'SNACKS', gebinde: '', packUnit: 'Einzel', priceCents: cents, vat: 7, pfand: [], ageCheck: 0 })
    );
    ACCESSORIES.forEach(([name, cents]) =>
      add({ name, brand: 'Simulation Zubehör', category: 'ZUBEH', gebinde: '', packUnit: 'Stück', priceCents: cents, vat: 19, pfand: [], ageCheck: 0 })
    );
    return out;
  }

  function defaultSettings() {
    return {
      marketName: 'Getränkemarkt Musterhausen',
      marketAddress: 'Beispielstraße 1 · 00000 Musterstadt',
      kassenNr: '1',
      paperWidth: 80,
      autoPrint: false,
      cardRejectRate: 0.1,
      soundOn: true,
      soundVolume: 0.5,
      soundKeys: false,
      scannerSuffix: 'Enter',
      scannerMinLen: 8,
      scannerMaxAvgMs: 50,
      scannerVerified: false,
      trainingMode: false,
      trainingDifficulty: 'ANFAENGER',
      keymap: {
        SUCHE: 'F1',
        MENGE: 'F2',
        PREIS: 'F3',
        POS_STORNO: 'F4',
        LEERGUT: 'F5',
        ZWISCHENSUMME: 'F6',
        BAR: 'F7',
        KARTE: 'F8',
        BON_DRUCKEN: 'F9',
        KASSIERERWECHSEL: 'F10',
        VOLLBILD: 'F11',
        BON_STORNO: 'Shift+F4',
        KASSENLADE: 'Shift+F5',
        SCHICHTENDE: 'Shift+F10',
        ESC: 'Escape',
      },
      favorites: [],
      // Tankstelle (Schema v2)
      fuelAuto: false,
      fuelArrivalPerMin: 2,
      fuelFaultPerHour: 0,
      // Bargeld-Automat (Schema v3). Simulierte Stoerungen wirken nur im Trainingsmodus.
      automatSimFaults: false,
      automatFaultRate: 0.12,
    };
  }

  // ---------------------------------------------------------------- Schema v2: Tankstelle

  const SHOP_CATEGORIES = [
    { id: 'KAFFEE', name: 'Kaffee und Heißgetränke' },
    { id: 'KALT', name: 'Kaltgetränke' },
    { id: 'SUESS', name: 'Süßwaren' },
    { id: 'EIS', name: 'Eis' },
    { id: 'BACK', name: 'Backwaren' },
    { id: 'ZEIT', name: 'Zeitungen' },
    { id: 'AUTOPFL', name: 'Autopflege' },
    { id: 'OEL', name: 'Motoröl' },
    { id: 'SCHEIB', name: 'Scheibenreiniger' },
    { id: 'AUTOZUB', name: 'Autozubehör' },
    { id: 'TSWEIT', name: 'Weitere Tankstellenprodukte' },
  ];

  /** [Kategorie, Bezeichnung, Preis in Cent, MwSt., Pfandart oder null, Verpackung] */
  const SHOP = [
    ['KAFFEE', 'Kaffee Becher klein 0,2 l', 179, 19, null, 'Einzel'],
    ['KAFFEE', 'Kaffee Becher groß 0,4 l', 249, 19, null, 'Einzel'],
    ['KAFFEE', 'Cappuccino Becher 0,25 l', 259, 19, null, 'Einzel'],
    ['KAFFEE', 'Latte Macchiato Becher 0,3 l', 289, 19, null, 'Einzel'],
    ['KAFFEE', 'Espresso Doppio 0,08 l', 199, 19, null, 'Einzel'],
    ['KAFFEE', 'Heiße Schokolade 0,3 l', 239, 19, null, 'Einzel'],
    ['KAFFEE', 'Früchtetee Becher 0,3 l', 199, 19, null, 'Einzel'],
    ['KAFFEE', 'Kaffeepads 10 Stück', 499, 19, null, 'Packung'],
    ['KALT', 'Cola Dose 0,33 l', 149, 19, 'EW25', 'Einzel'],
    ['KALT', 'Energy Dose 0,25 l', 199, 19, 'EW25', 'Einzel'],
    ['KALT', 'Eistee Flasche 0,5 l', 179, 19, 'EW25', 'Einzel'],
    ['KALT', 'Wasser still Flasche 0,5 l', 119, 19, 'MW08', 'Einzel'],
    ['KALT', 'Smoothie 0,25 l', 229, 19, 'EW25', 'Einzel'],
    ['KALT', 'Sportgetränk 0,5 l', 189, 19, 'EW25', 'Einzel'],
    ['KALT', 'Schorle Dose 0,33 l', 139, 19, 'EW25', 'Einzel'],
    ['SUESS', 'Schokoriegel Vollmilch 50 g', 99, 7, null, 'Einzel'],
    ['SUESS', 'Kaugummi Pellets Dose', 159, 7, null, 'Einzel'],
    ['SUESS', 'Lakritzschnecke 80 g', 89, 7, null, 'Einzel'],
    ['SUESS', 'Fruchtgummi Mix 120 g', 129, 7, null, 'Einzel'],
    ['SUESS', 'Schokoladentafel Nuss 100 g', 159, 7, null, 'Einzel'],
    ['SUESS', 'Bonbons Minze 90 g', 109, 7, null, 'Einzel'],
    ['EIS', 'Eis am Stiel Erdbeere', 129, 7, null, 'Einzel'],
    ['EIS', 'Eisbecher Vanille 120 ml', 199, 7, null, 'Einzel'],
    ['EIS', 'Eis Waffelhörnchen Schoko', 149, 7, null, 'Einzel'],
    ['EIS', 'Eiskonfekt Sahne 4 Stück', 349, 7, null, 'Packung'],
    ['BACK', 'Brötchen Hefeteig 2 Stück', 149, 7, null, 'Packung'],
    ['BACK', 'Croissant Butter', 169, 7, null, 'Einzel'],
    ['BACK', 'Laugenbrezel', 129, 7, null, 'Einzel'],
    ['BACK', 'Muffin Schoko', 179, 7, null, 'Einzel'],
    ['BACK', 'Käsebrötchen', 199, 7, null, 'Einzel'],
    ['ZEIT', 'Tageszeitung Regional', 230, 7, null, 'Einzel'],
    ['ZEIT', 'Wochenmagazin Auto', 590, 7, null, 'Einzel'],
    ['ZEIT', 'Stadtmagazin', 350, 7, null, 'Einzel'],
    ['AUTOPFL', 'Autoshampoo Konzentrat 500 ml', 549, 19, null, 'Flasche'],
    ['AUTOPFL', 'Felgenreiniger Spray 500 ml', 699, 19, null, 'Flasche'],
    ['AUTOPFL', 'Lackpflege Wachs 250 ml', 1199, 19, null, 'Dose'],
    ['AUTOPFL', 'Mikrofasertücher 3er Pack', 499, 19, null, 'Packung'],
    ['AUTOPFL', 'Reifenglanz Spray 400 ml', 599, 19, null, 'Dose'],
    ['AUTOPFL', 'Polsterreiniger Schaum 400 ml', 799, 19, null, 'Dose'],
    ['OEL', 'Motoröl 5W-30 1 Liter', 699, 19, null, 'Flasche'],
    ['OEL', 'Motoröl 5W-30 5 Liter', 2499, 19, null, 'Kanister'],
    ['OEL', 'Motoröl 10W-40 1 Liter', 649, 19, null, 'Flasche'],
    ['OEL', 'Motoröl 10W-40 4 Liter', 1999, 19, null, 'Kanister'],
    ['OEL', 'Getriebeöl 75W-90 1 Liter', 1199, 19, null, 'Flasche'],
    ['OEL', 'Kühlerfrostschutz 1,5 Liter', 899, 19, null, 'Flasche'],
    ['SCHEIB', 'Scheibenreiniger Konzentrat 5 Liter', 999, 19, null, 'Kanister'],
    ['SCHEIB', 'Scheibenreiniger Sommer 500 ml', 299, 19, null, 'Flasche'],
    ['SCHEIB', 'Scheibenreiniger Winter bis -22 °C 1 Liter', 499, 19, null, 'Flasche'],
    ['SCHEIB', 'Eisentfroster Spray 500 ml', 499, 19, null, 'Dose'],
    ['AUTOZUB', 'Warndreieck', 1490, 19, null, 'Einzel'],
    ['AUTOZUB', 'Verbandkasten nach DIN 13164', 2490, 19, null, 'Einzel'],
    ['AUTOZUB', 'Kfz-Ladekabel USB-C', 1299, 19, null, 'Einzel'],
    ['AUTOZUB', 'Ersatzlampen-Set H7', 899, 19, null, 'Packung'],
    ['AUTOZUB', 'Eiskratzer mit Bürste', 399, 19, null, 'Einzel'],
    ['TSWEIT', 'Feuerzeug Gas', 299, 19, null, 'Einzel'],
    ['TSWEIT', 'Batterien AA 4er Pack', 599, 19, null, 'Packung'],
    ['TSWEIT', 'Taschentücher Box', 129, 19, null, 'Einzel'],
    ['TSWEIT', 'Pflasterset 20 Stück', 299, 19, null, 'Packung'],
    ['TSWEIT', 'Handyladekabel Micro-USB', 799, 19, null, 'Einzel'],
    ['TSWEIT', 'Sonnenbrille einfach', 1499, 19, null, 'Einzel'],
  ];

  /** Tankstellenartikel. Laufende Nummern ab startSeq, damit EAN und PLU eindeutig bleiben. */
  function buildShopArticles(startSeq) {
    let seed = 7;
    return SHOP.map(([category, name, priceCents, vat, dep, packUnit], i) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      const low = seed % 11 === 0;
      const seq = startSeq + i;
      return {
        plu: String(1000 + seq),
        ean: E.simulationEan13('200', seq),
        name,
        brand: 'Simulation Tankstelle',
        category,
        gebinde: '',
        packUnit,
        priceCents,
        vat,
        pfand: dep ? [{ depositId: dep, qty: 1 }] : [],
        ageCheck: 0,
        stock: low ? 2 : 15 + (seed % 40),
        minStock: 5 + (seed % 6),
        active: true,
        simulation: true,
      };
    });
  }

  /** Kraftstoffe. Menge in ml, Literpreis in Milli-Euro (1759 = 1,759 €/l). */
  function buildFuels() {
    return [
      { id: 'E5', name: 'Super E5', priceMilli: 1799, vat: 19, stockMl: 30000000, minMl: 5000000 },
      { id: 'E10', name: 'Super E10', priceMilli: 1759, vat: 19, stockMl: 40000000, minMl: 5000000 },
      { id: 'SP', name: 'Super Plus', priceMilli: 1889, vat: 19, stockMl: 15000000, minMl: 3000000 },
      { id: 'D', name: 'Diesel', priceMilli: 1699, vat: 19, stockMl: 45000000, minMl: 8000000 },
      { id: 'PD', name: 'Premium Diesel', priceMilli: 1819, vat: 19, stockMl: 12000000, minMl: 3000000 },
      { id: 'AB', name: 'AdBlue', priceMilli: 1190, vat: 19, stockMl: 8000000, minMl: 2000000 },
    ];
  }

  /** Acht Zapfsäulen mit fester Kraftstoffzuordnung (in der Verwaltung änderbar). */
  function buildPumps() {
    const fuelOfPump = ['E5', 'E5', 'E10', 'E10', 'SP', 'D', 'PD', 'AB'];
    return fuelOfPump.map((fuelId, i) => ({ id: i + 1, name: `Zapfsäule ${i + 1}`, fuelId, status: 'FREI', tankId: null, since: null, nextAt: null }));
  }

  /**
   * Schema v1 -> v2. Bestehende Daten (Artikel, Verkäufe, Schichten, Pfandbons, Personal, Protokoll)
   * bleiben unverändert. Ergänzt werden: Kraftstoffe, Zapfsäulen, Tankvorgänge, Tankstellen-Artikel
   * und Einstellungen. Idempotent: ein bereits v2-konformer Stand wird nicht verändert.
   */
  function upgradeToV2(s) {
    if (s.schemaVersion >= 2) return s;
    const defs = defaultSettings();
    s.settings = s.settings || {};
    for (const [k, v] of Object.entries(defs)) {
      if (!(k in s.settings)) s.settings[k] = v;
    }
    s.categories = s.categories || [];
    for (const c of SHOP_CATEGORIES) {
      if (!s.categories.some((x) => x.id === c.id)) s.categories.push({ ...c, sort: s.categories.length + 1 });
    }
    if (!s.articles.some((a) => a.category === 'KAFFEE')) {
      const maxSeq = s.articles.reduce((m, a) => (a.ean && a.ean.startsWith('200') ? Math.max(m, parseInt(a.ean.slice(3, 12), 10)) : m), 0);
      const base = s.counters.article || s.articles.length;
      const shop = buildShopArticles(maxSeq + 1);
      shop.forEach((a, i) => {
        s.articles.push({ id: 'A' + String(base + i + 1).padStart(4, '0'), ...a });
      });
      s.counters.article = base + shop.length;
    }
    s.fuels = s.fuels || buildFuels();
    s.pumps = s.pumps || buildPumps();
    s.tanks = s.tanks || [];
    s.counters = { ...s.counters, tank: s.counters.tank || 0 };
    s.schemaVersion = 2;
    return s;
  }

  /**
   * Schema v3: Bargeld-Automat. Bestehende Daten bleiben unveraendert. Der Automat startet mit
   * seinem Anfangsbestand, der als eigene Bewegung (Typ INITIAL) gebucht wird. Offene Schichten
   * erhalten den Automatenbestand als Startwert, damit der Schichtabschluss rechnen kann.
   */
  function upgradeToV3(s, now = new Date()) {
    if (s.schemaVersion >= 3) return s;
    s.settings = s.settings || {};
    const defs = defaultSettings();
    for (const k of ['automatSimFaults', 'automatFaultRate']) {
      if (!(k in s.settings)) s.settings[k] = defs[k];
    }
    s.automat = s.automat || { mode: 'BETRIEBSBEREIT', fault: null, slots: POS.Automat.defaultSlots() };
    s.automatMoves = s.automatMoves || [];
    s.automatSession = s.automatSession || null;
    s.automatSessions = s.automatSessions || [];
    if (!s.automatMoves.length) {
      const ts = now.toISOString();
      let seq = s.counters.automatmove || 0;
      for (const slot of s.automat.slots) {
        if (!(slot.initial > 0)) continue;
        seq += 1;
        s.automatMoves.push({
          id: seq,
          ts,
          shiftId: null,
          type: 'INITIAL',
          denom: slot.value,
          count: slot.initial,
          cents: slot.value * slot.initial,
          ref: null,
          reason: 'Anfangsbestand Automat',
          cashierId: null,
        });
      }
      s.counters = { ...s.counters, automatmove: seq };
    }
    const total = POS.Automat.totalCents(s);
    for (const sh of s.shifts) {
      if (sh.status === 'OFFEN' && sh.machineStartCents === undefined) sh.machineStartCents = total;
    }
    s.schemaVersion = 3;
    return s;
  }

  /** Vollstaendiger Startzustand fuer eine frische Installation (Schema v2). */
  function createInitialState(now = new Date()) {
    const articles = buildArticles();
    const settings = defaultSettings();
    settings.favorites = CATEGORIES.slice(0, 12)
      .map((c) => articles.find((a) => a.category === c.id))
      .filter(Boolean)
      .map((a) => a.id);
    const base = {
      schemaVersion: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      settings,
      categories: CATEGORIES.map((c, i) => ({ ...c, sort: i + 1 })),
      deposits: DEPOSITS.map((d) => ({ ...d })),
      articles,
      staff: STAFF.map((s) => ({ ...s })),
      shifts: [],
      cashMoves: [],
      sales: [],
      stockMoves: [],
      vouchers: [],
      events: [],
      trainingResults: [],
      trainingCustomer: null,
      cart: null,
      counters: { article: articles.length, staff: STAFF.length, bon: 0, ret: 0, shift: 0, cashmove: 0, stock: 0, event: 0, voucher: 0, ean: 0 },
    };
    return upgradeToV3(upgradeToV2(base), now);
  }

  POS.Seed = {
    SCHEMA_VERSION,
    CATEGORIES,
    SHOP_CATEGORIES,
    DEPOSITS,
    STAFF,
    buildArticles,
    buildShopArticles,
    buildFuels,
    buildPumps,
    defaultSettings,
    createInitialState,
    upgradeToV2,
    upgradeToV3,
    endPrice,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// Campos de la ficha del piloto y de la moto. Los usan la app y el panel de
// administración, para que ambos muestren las mismas etiquetas.
var PERFIL=[
["Datos personales",[["nombre","Nombre completo"],["rut","RUT"],["nac","Fecha de nacimiento","date"],["direccion","Dirección"],["comuna","Comuna / ciudad"],["telefono","Teléfono","tel"],["correo","Correo electrónico","email"]]],
["Previsión y seguro",[["prevision","Previsión",["","Fonasa","Isapre","Otra","Sin previsión"]],["isapre","Isapre / detalle"],["seguro","Seguro de accidentes (compañía y n.° póliza)"],["clinica","Centro de salud preferido"]]],
["En caso de emergencia llamar a",[["emNombre","Nombre"],["emParentesco","Parentesco"],["emTel","Teléfono","tel"],["emTel2","Teléfono alternativo","tel"]]],
["Información médica",[["sangre","Grupo sanguíneo",["","O+","O-","A+","A-","B+","B-","AB+","AB-"]],["alergias","Alergias","textarea"],["enfermedades","Enfermedades o condiciones","textarea"],["medicamentos","Medicamentos de uso habitual","textarea"],["antecedentes","Antecedentes médicos importantes (lesiones, cirugías, etc.)","textarea"]]],
["Competencia",[["licencia","N.° de licencia"],["categoria","Categoría"],["nCarrera","N.° de carrera"],["equipo","Equipo / club"],["experiencia","Años de experiencia"]]]
];
var MOTO=[
["Identificación",[["apodo","Nombre de la moto (ej. R3 pista)"],["marca","Marca"],["modelo","Modelo"],["anio","Año","number"],["cc","Cilindrada (cc)","number"],["color","Color"],["patente","Patente / n.° de chasis"]]],
["Motor y transmisión",[["pinon","Piñón (dientes)","number"],["corona","Corona / catalina (dientes)","number"],["aceite","Aceite / lubricante"],["escape","Escape / admisión"],["ecu","Mapa de ECU / modificaciones de motor","textarea"]]],
["Chasis y suspensión",[["horquilla","Horquilla (aceite, resortes, altura)"],["amortiguador","Amortiguador trasero"],["precarga","Precarga / compresión / rebote","textarea"],["geometria","Geometría (altura, ángulos, etc.)"]]],
["Neumáticos y frenos",[["neumatico","Marca y compuesto de neumáticos"],["presionD","Presión delantera fría (psi)","number"],["presionT","Presión trasera fría (psi)","number"],["frenos","Pastillas y discos"]]],
["Notas",[["notas","Otras características mecánicas","textarea"]]]
];
// Campos que pueden marcarse como «No aplica» (por ejemplo, quien no tiene
// seguro de accidentes o no compite).
var NA_TXT="No aplica";
var NA=["isapre","seguro","clinica","emTel2","alergias","enfermedades","medicamentos","antecedentes","licencia","categoria","nCarrera","equipo"];
// Campos que no se piden según otra respuesta: con Fonasa no hay Isapre.
var OCULTO={isapre:function(d){return d.prevision==="Fonasa"||d.prevision==="Sin previsión"}};
// Deportes motor: id, nombre, tipo de vehículo (moto, kart o auto) y hashtag.
// Las sesiones y los vehículos llevan el deporte; lo anterior a esto es "moto".
var DEPORTES=[["moto","Motociclismo de pista","moto","Motociclismo"],["mx","Motocross","moto","Motocross"],["enduro","Enduro","moto","Enduro"],["supermoto","Supermoto","moto","Supermoto"],["karting","Karting","kart","Karting"],["auto","Automovilismo","auto","Automovilismo"]];
function dep(id){return DEPORTES.filter(function(d){return d[0]===id})[0]||DEPORTES[0]}
var VEH={moto:"Moto",kart:"Kart",auto:"Auto"};
// Medallas, copas y niveles. Debe coincidir con api/src/lib/logros.js:
// 1 punto por minuto en pista y 30 por cada récord personal roto.
var PREMIOS={puntosRecord:30,
 niveles:[[0,"Novato"],[120,"Aprendiz"],[400,"Piloto"],[900,"Competidor"],[1800,"Experto"],[3500,"Élite"],[6000,"Leyenda"]],
 medallas:[[1,"Bronce","#c27c3e"],[5,"Plata","#9aa3ad"],[10,"Oro","#d4a017"],[25,"Platino","#5fb3c9"],[50,"Diamante","#8a6cf0"]],
 copas:[[60,"1 hora","#c27c3e"],[300,"5 horas","#9aa3ad"],[600,"10 horas","#d4a017"],[1500,"25 horas","#5fb3c9"],[3000,"50 horas","#8a6cf0"],[6000,"100 horas","#d4232a"]]};
var TIPOS=["Práctica","Entrenamiento","Clase","Clasificación","Carrera","Campeonato","Exhibición"];

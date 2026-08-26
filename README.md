# LinkedIn → Brevo

Extension Chrome (Manifest V3, sans build) : depuis une fiche LinkedIn ou Sales Navigator, un clic crée le contact dans Brevo, rattache/crée sa société, l'enrichit (effectif, CA, procédure collective, département, ville) et ouvre la fiche Brevo dans un nouvel onglet.

## Installation

1. Chrome → `chrome://extensions` → activer le **Mode développeur** → **Charger l'extension non empaquetée** → choisir ce dossier.
2. Cliquer sur l'icône de l'extension (ou ⚙ dans le panneau) pour ouvrir les options :
   - coller la **clé API Brevo v3** (Brevo → Paramètres → SMTP & API → Clés API) ;
   - **Tester la connexion**, puis **Vérifier les attributs** (crée les attributs contact manquants : `PRENOM`, `NOM`, `TITRE`, `SOCIETE`, `LANGUE`, `QUALIFIE`, `TELEPHONE_SOCIETE`, `LINKEDIN`, `TUTOIEMENT` (booléen)).
3. Les attributs **société** ne peuvent pas être créés par l'API : si « Site Web », « Nombre d'employés », « Revenus », « CP », « Ville » (et « Statut », optionnel) manquent dans Brevo → Entreprises → Attributs, créez-les avec ces libellés exacts.

## Utilisation

1. Ouvrir un profil `linkedin.com/in/…` ou un lead Sales Navigator, cliquer sur **Ajouter à Brevo** (bouton en bas à droite).
2. Le panneau pré-remplit prénom, nom, titre, société, email, téléphone, site web, langue — corrigez si besoin, cochez **Tutoiement** si le contact se tutoie (décoché par défaut → `TUTOIEMENT` = faux), puis **Créer dans Brevo**.
3. Étapes automatiques :
   - site web de la société (page LinkedIn de l'entreprise, sinon saisie manuelle) ;
   - si ni email ni téléphone : recherche d'un téléphone sur le site de la société ; sinon email générique `prenom.nom.societe@<domaine>`. `QUALIFIE` vaut « Oui » dès qu'un email ou un téléphone (personnel ou société) a été trouvé, « Non » sinon ;
   - contact déjà présent : ses attributs vides sont complétés (`QUALIFIE`, `SOCIETE`, `LINKEDIN`…), les valeurs existantes ne sont pas modifiées ;
   - société : réutilisation de la société Brevo existante (son nom fait foi) ou création, puis rattachement du contact ;
   - enrichissement via l'[API Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr) (SIREN trouvé sur le site, sinon par nom) et le [BODACC](https://bodacc-datadila.opendatasoft.com) (RJ / liquidation / sauvegarde) ; si la société Brevo contient déjà ces infos, une confirmation est demandée avant mise à jour ;
   - ouverture de la fiche contact Brevo.

L'URL du profil (`https://www.linkedin.com/in/<slug>/`) est écrite dans l'attribut `LINKEDIN` et le slug dans `EXT_ID` à chaque création.

## Mise à jour des contacts existants (URL LinkedIn)

Options → **Rechercher les URL LinkedIn manquantes** : pour chaque contact Brevo dont `LINKEDIN` est vide,
- si `EXT_ID` contient un slug de profil (contact créé par l'extension), l'URL est reconstruite et enregistrée ;
- sinon l'extension interroge la recherche de personnes LinkedIn (`/search/results/people/?keywords=…`, page rendue côté serveur : un simple `fetch` avec les cookies suffit, sans ouvrir d'onglet) avec « Prénom Nom Société » puis, faute de résultat, « Prénom Nom » ;
- correspondance **sûre** (nom identique + société retrouvée dans le titre, ou résultat unique pour la requête avec société) → enregistrée directement ; sinon les candidats sont listés avec un bouton **Utiliser** (nom seul, plusieurs homonymes, prénom composé…).

Il faut être connecté à LinkedIn dans le navigateur. Les requêtes sont espacées de 2,5 à 4 s et plafonnées par passage (réglage « Recherches LinkedIn max. par passage ») ; un HTTP 429 ou une redirection vers la page de connexion arrête le passage. Le bouton **Arrêter** interrompt après le contact en cours.

## Comment l'extension lit LinkedIn

LinkedIn sert désormais une interface « SDUI » (rendu serveur, React) : plus de `<h1>`, plus de JSON embarqué, anciens endpoints `voyager/api/identity/profiles/*` supprimés (410). L'extension lit donc :
- les cartes `div[id^="com.linkedin.sdui.profile.card."]` (`…Topcard` : nom en `h2`, headline ; `…ExperienceTopLevelSection` : premier poste, société, lien `/company/<id>/`). La carte Expérience est chargée au défilement : le script fait défiler `main#workspace` puis revient en haut ;
- les coordonnées via l'appel serveur que fait l'overlay « Coordonnées » (`POST /flagship-web/rsc-action/actions/navigation?screenId=…ProfileContactDetailsOverlay`, jeton `csrf-token` = cookie `JSESSIONID`), sans ouvrir la pop-up ;
- le site web sur la page entreprise `/company/<id>/about/` (encore rendue par l'ancien moteur : JSON `websiteUrl` dans des blocs `<code>` encodés en entités HTML).
L'ancienne interface (Ember) reste gérée en repli.

Correspondance annuaire : uniquement nom identique (formes juridiques ignorées) ou préfixe ; « Ville de X » est retentée en « Commune de X ». Sinon l'extension propose les candidats et vous choisissez (ou « Aucune »).

## Notes

- Identifiant Brevo : email réel, sinon email générique (un contact Brevo exige un identifiant). Le téléphone personnel va dans `SMS` ; un numéro de standard trouvé sur le site va dans `TELEPHONE_SOCIETE` (le champ `SMS` doit être unique par contact).
- « Nombre d'employés » : l'annuaire ne donne qu'une tranche INSEE ; si l'attribut Brevo est numérique, la borne basse de la tranche est écrite (ex. `10` pour « 10 à 19 »), sinon le libellé avec l'année.
- Les sélecteurs LinkedIn changent souvent : le formulaire du panneau est toujours modifiable avant envoi.

## Tests

```
npm test
```
(Node ≥ 20, `node --test` sur les fonctions pures : normalisation, exploration de site, annuaire/BODACC, client Brevo, recherche de personnes LinkedIn.)

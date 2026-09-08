# Krismeddelanden

## Underlag för pitch deck

8 september 2026

Vår app hjälper mottagaren att kontrollera vem som har publicerat ett krismeddelande, om texten är oförändrad och om en nyare version har ersatt det. Kontrollen sker automatiskt. Mottagaren behöver varken konto, kryptoplånbok eller kunskap om blockkedjor.

Det här underlaget förklarar problemet, vår lösning, användarupplevelsen och tekniken. Sist finns en föreslagen berättelse för pitch decken. Projektet utforskar Svenska Röda Korsets problemområde kring säker kriskommunikation. Appen använder en fiktiv Demoorganisation och visar inte verklig verifiering av Svenska Röda Korset.

## Problemet vi vill lösa

Vid en kris behöver volontärer och samordnare kunna agera på tydliga instruktioner. Ett meddelande kan samtidigt vara svårt att bedöma: kommer det från rätt avsändare, har någon ändrat texten och gäller instruktionen fortfarande?

En trovärdig avsändarbild eller en vidarebefordrad text räcker inte för att besvara de frågorna. Ett gammalt meddelande kan dessutom vara helt äkta och ändå ge fel vägledning efter en uppdatering. Om meddelandelagringen manipuleras kan mottagaren få ändrad text eller bara en äldre version.

Konsekvensen kan bli extra kontrollsamtal, osäkerhet och att människor agerar på fel tid eller plats. Det är problemhypoteser som behöver prövas med användare; projektet har ännu inga uppmätta effektresultat.

## Vår lösning

Den behöriga publiceraren signerar ett exakt meddelande och registrerar ett kryptografiskt kontrollvärde i ett separat register på en blockkedja. Mottagarens app jämför levererad text och signatur med den förkonfigurerade avsändaren och registerinformationen.

Appen visar både om text och signatur stämmer och om meddelandet är den aktuella eller en ersatt version. Om kontrollen inte kan genomföras visas osäkerheten tydligt.

**Förslag på kärnformulering:** Vi gör det enkelt att kontrollera avsändare, oförändrat innehåll och aktuell version i kriskommunikation, direkt där mottagaren läser meddelandet.

<!-- pagebreak -->

## Användarsidan

### Alex publicerar och Kim tar emot

Alex representerar en samordnare med rätt att publicera. Kim representerar en volontär som följer det förinställda flödet Övning Norr. Dagens MVP har en publicerare, ett flöde och en serie meddelandeversioner.

1. Alex skriver ett meddelande och väljer **Granska meddelandet**. Appen låser den exakta text som ska signeras.
2. Alex väljer **Signera och publicera**. I sin webbläsarplånbok godkänner Alex först signaturen och sedan publiceringstransaktionen.
3. Appen lagrar det signerade paketet och kontrollerar att publiceringen har bekräftats på kedjan. Ett inskickat transaktions-ID räcker inte som bekräftelse.
4. Kim öppnar inkorgen i en separat webbläsarsession. Appen hämtar och kontrollerar meddelanden automatiskt, utan inloggning eller verifieringsknapp.
5. När Alex publicerar nästa version kontrolleras den på nytt. Den äldre versionen finns kvar och märks som ersatt.

### Ett exempel att använda i pitchen

**Första meddelandet:** ”Samling vid övningsplats Norr klockan 14.00. Ta med reflexväst och vatten.” Kim ser texten och att versionen är aktuell efter genomförd kontroll.

**Manipulation:** Någon ändrar den lagrade tiden till 16.00 utan Alex signatur. Kim får en underkänd leverans eftersom texten inte längre matchar det signerade innehållet. En tidigare verifierad kopia behålls separat.

**Riktig uppdatering:** Alex ändrar själv tiden till 16.00 och signerar en ny version. Kim ser den nya versionen som aktuell och 14.00-versionen som ersatt. Samma textändring får alltså olika resultat beroende på om den är korrekt signerad och publicerad.

### Vad mottagaren ser

- **Aktuell version:** kontrollerna stämmer och paketet motsvarar registrets senaste version vid kontrolltillfället.
- **Ersatt version:** meddelandet är verifierat men en nyare version har publicerats.
- **Underkänd leverans:** text, signatur, sammanhang eller publiceringsbevis stämmer inte.
- **Väntar på kontroll eller aktuell status okänd:** underlaget är ännu inte bekräftat eller går inte att kontrollera.

Tekniska detaljer ligger under **Visa kontrollunderlag**. Den viktigaste nyttan för Kim är att kunna läsa instruktionen och förstå dess status utan att tolka adresser, hashvärden eller transaktioner.

<!-- pagebreak -->

## Tekniken bakom

### Två vägar som möts hos mottagaren

**Innehåll:** Alex → signerat paket → API och databas → Kims app.

**Kontrollunderlag:** Alex → publiceringstransaktion → CrisisRegistry → Kims app via RPC.

RPC är anslutningen som appen använder för att läsa blockkedjan. Kims app kontrollerar innehållet mot registerinformationen själv. Ett påstående i databasen om att ett meddelande är verifierat ger därför inget godkännande.

### Vad som signeras

En hash är ett kryptografiskt kontrollvärde för data. Appen beräknar `bodyHash` med keccak256 över den exakta UTF-8-texten. Även mellanslag och tecken ingår. Texten putsas inte till före kontrollen.

Signaturen använder EIP-712, ett strukturerat signeringsformat. Den binder innehållshashen till avsändare, organisation, flöde, meddelandeserie, versionsnummer och föregående versions paketdigest. Signeringsdomänen binder dessutom paketet till rätt kedja och kontrakt.

`packageDigest` är kontrollvärdet för hela det strukturerade signeringsunderlaget. Det skiljer sig från `bodyHash`, som bara avser meddelandetexten. Därmed räcker det inte att behålla texten men byta avsändare, version eller sammanhang.

### Vad som ligger var

- **React och TypeScript:** publiceringsvy, inkorg och mottagarens verifiering. Vite används för utveckling och bygge.
- **Node och SQLite:** API som lagrar och levererar exakt text, signerat paket och leveransreferenser. Databasen är inte en betrodd källa för godkännande.
- **CrisisRegistry i Solidity:** registrerar paketdigest och publiceringsblock per version samt håller reda på senaste versionen. Texten skickas inte till kontraktet, inte heller i transaktionens indata eller händelser.
- **viem och OpenZeppelin:** etablerade bibliotek för kedjeinteraktion, strukturerade signaturer och kryptografiska kontroller.
- **Webbläsarens lokala lagring:** sparade paket och ofärdiga publiceringsförsök. Paketen verifieras på nytt efter omladdning.

### Varför en blockkedja

Signaturen binder innehållet till publicerarens nyckel. Registret tillför en separat publiceringshistorik och en referens för vilken version som är senast. Om databasen enbart levererar en gammal, korrekt signerad version kan mottagaren ändå upptäcka att den har ersatts.

Detta motiverar teknikvalet i prototypen. Det bevisar inte att en publik blockkedja är bäst i produktion. Kostnad, svarstid, driftberoenden och alternativ som signerade transparensloggar behöver jämföras inför ett sådant beslut.

<!-- pagebreak -->

## Tillit och felhantering

### Vad verifieringen faktiskt betyder

**Äkthet och behörighet:** signaturen måste komma från den publicerarnyckel som är förkonfigurerad för organisationen och flödet. En godtycklig plånbok blir inte behörig bara för att den kan signera.

**Innehållsintegritet:** den mottagna texten och dess sammanhang måste matcha det signerade paketet. Ändringar utan en ny giltig signatur underkänns.

**Aktuell status:** appen läser även registrets senaste version. En giltig signatur bevisar inte att ett meddelande fortfarande är det senaste.

**Sanningshalt:** systemet avgör inte om instruktionen är sakligt korrekt eller klok. En behörig publicerare kan fortfarande göra ett misstag.

### Varifrån tilliten kommer

Dagens tillitsrot är en separat konfiguration med rätt publiceraradress, organisation, flöde, kedja och kontrakt. Kontraktet låser en publicerare och ett sammanhang vid driftsättning. Paket från databasen får inte välja en ny betrodd avsändare eller ett annat register.

MVP:n förutsätter att publicerarens nyckel, appkoden, tillitskonfigurationen och RPC-anslutningen är betrodda. Den demonstrerade angriparen kan ändra databasen men kontrollerar inte dessa delar. En lokal Anvil-kedja är en kontrollerad testmiljö, inte ett oberoende publikt nätverk.

### När något går fel

- **Ändrad databastext:** leveransen underkänns när den inte matchar signaturen. En tidigare verifierad kopia skrivs inte över av den felaktiga leveransen.
- **Bara gammal text levereras:** kedjans senaste versionsreferens avslöjar att den gamla versionen är ersatt. Om den nya texten saknas säger appen det.
- **Text raderas:** appen visar saknat innehåll eller en separat sparad kopia. Ett hashvärde kan inte återskapa texten.
- **Nätverket eller kontrollunderlaget saknas:** aktuell status blir okänd. Tidpunkten för en tidigare lyckad kontroll är historik, inte en ny bekräftelse.
- **Publiceringen avbryts:** ett sparat försök kan återupptas med samma paket. Appen skapar inte automatiskt en ny version eller transaktion när utfallet är oklart.

På Sepolia kräver appen en lyckad inkluderad transaktion och matchande register-, händelse- och kvittounderlag. Det är kedjebekräftelse, inte slutgiltig finalitet. Kedjeomorganisationer kan inträffa och senare kontroller läser bevisen igen.

<!-- pagebreak -->

## Vad som finns och vad som återstår

### Implementerat i projektet

MVP:n på `/publish` och `/inbox` har riktiga signaturer, ett API, beständig SQLite-lagring, kontrakt och automatisk mottagarverifiering. Den har versionshistorik, hantering av saknat kontrollunderlag och återupptagning av ofärdig publicering.

Samma app- och kontraktskod stödjer två profiler: lokal Anvil och Ethereum Sepolia L1. Sepolia kräver separat konfiguration och uttrycklig driftsättning. Stöd i koden ska inte presenteras som bevis för en genomförd publik driftsättning.

Projektet innehåller automatiska tester för bland annat signaturer, ändrad text och metadata, obehöriga avsändare, versionskonflikter, databasmanipulation, nätverksfel och separata publicerar- och mottagarsessioner. Dokumentet är ingen ny testkörningsrapport. Vanliga plånbokstilläggs egna godkännandedialoger är enligt README en kvarvarande manuell kontroll.

### Separat simulerad presentation

Startsidan `/` visar fem pedagogiska scenarier: publicering, vidarebefordran, uppdatering, avbrott i uppkopplingen och databasmanipulation. Signering och kedjekontroller där är simulerade. Vidarebefordringsflödet ska därför inte beskrivas som en färdig funktion i den riktiga MVP:n.

### Förslag till nästa steg

1. Pröva användarnyttan med samordnare och volontärer. Förstår de skillnaden mellan aktuell, ersatt och okänd status under tidspress?
2. Definiera verklig organisationsbehörighet: vem får ge ut och återkalla publicerarnycklar, och vad händer om en nyckel förloras eller stjäls? Dagens kontrakt saknar nyckelrotation och återkallelse.
3. Utforma distribution, tillgänglighet och drift för verklig användning. Dagens servrar kör på den lokala datorn; reservkanaler och en färdig lösning för leverans utan uppkoppling ingår inte.
4. Utvärdera skala, publiceringstid och kostnad. MVP:n är avgränsad till en liten serie och har en gräns på 1 000 paket vid hämtning och i sparad historik.

AI-generering, AI-faktagranskning, flera organisationer och bred administration är inte implementerade. Det finns inte heller underlag här för påståenden om kunder, partnerskap, intäkter eller bevisad samhällseffekt.

### Ett tydligt demonstrationsögonblick

Visa Kim i en separat session. Publicera 14.00, demonstrera en osignerad databasändring till 16.00 och visa underkännandet. Återställ sedan datan och publicera 16.00 korrekt som nästa version. Kim ser skillnaden mellan manipulation och en behörig uppdatering. Manipulationsmomentet i MVP:n görs med projektets lokala CLI-demoverktyg, inte med en knapp i mottagarvyn.

<!-- pagebreak -->

## Förslag till pitch deck

### En berättelse i åtta bilder

1. **Problemet.** Visa två likadana instruktioner med olika samlingstid. Förklara osäkerheten kring avsändare, ändringar och gamla versioner.
2. **Människorna.** Presentera samordnaren Alex och volontären Kim. Kim behöver förstå vilken instruktion som är aktuell utan en extra teknisk arbetsuppgift.
3. **Lösningen.** Visa inkorgen med text, automatisk kontroll och versionsstatus. Börja med nyttan för mottagaren.
4. **Användarflödet.** Alex skriver, granskar, signerar och publicerar. Kim får meddelandet och kontrollresultatet automatiskt.
5. **Demonstrationen.** Jämför en manipulerad 16.00-text med Alex korrekt publicerade 16.00-uppdatering. Förklara varför utfallet skiljer sig.
6. **Tekniken.** Visa två vägar: innehållet via databasen och kontrollunderlaget via registret. De möts i mottagarens verifiering.
7. **Vad vi har byggt.** Visa den riktiga MVP:n. Märk den simulerade presentationen och lokalt nätverk eller testnät tydligt. Ange exakt vad demonstrationen använder.
8. **Nästa steg.** Föreslå en avgränsad användarvalidering och ett arbete med verklig organisationsbehörighet. Anpassa avslutningen till den respons ni faktiskt vill ha från publiken.

### Kort pitch att utgå från

”När instruktioner ändras under en kris räcker det inte att ett meddelande ser trovärdigt ut. Volontären behöver kunna kontrollera vem som skickat det, om texten har ändrats och om en nyare version finns. Vår app gör de kontrollerna automatiskt. Samordnaren signerar meddelandet och registrerar dess publicering. Mottagaren läser det i en vanlig inkorg utan konto eller kryptoplånbok. Prototypen visar hur manipulerad text underkänns och en riktig uppdatering ersätter den gamla. Nästa steg är att pröva nyttan med användare och definiera hur verkliga organisationer ska hantera behörigheten.”

### Frågor att vara redo för

**Behöver alla krypto?** Kim behöver ingen plånbok eller token. Alex behöver i dagens MVP en plånbok och test-ETH för publiceringstransaktioner.

**Är kommunikationen krypterad?** Signeringen kontrollerar äkthet och integritet. Den beskrivna MVP:n erbjuder inte end-to-end-kryptering av texten.

**Var finns AI?** Ingen AI-funktion är implementerad. Projektets bidrag här är verifierbart ursprung, integritet och versionsstatus.

### Projektunderlag

Beskrivningen avser källkod vid commit `64b4f84`. Se [README](../README.md), [användargränssnitt](../src/live/App.tsx), [signeringsformat](../shared/protocol.ts), [kontrakt](../contracts/CrisisRegistry.sol), [publicering](../src/live/publish.ts) och [mottagarverifiering](../src/live/inbox.ts). Effektbeskrivningar och nästa steg är förslag, inte uppmätta resultat eller beslutade åtaganden.

export const MATERIAL_REASONING_LOOP = [
  "The working char's material blaze_eye_R.vmt is ONLY in the custom folder. So studiomdl DOES search the custom folder. And the spy's material is ALSO in the custom folder. So why does spy fail?",
  "Let me reconsider. Maybe the difference is in the actual texture files. Let me check whether the spy's rouge_eye.vtf is a valid VTF. The dir listing showed rouge_eye.vtf is 65,624 bytes. And blaze_eye.vtf — let me check its size.",
  "Actually, wait. Let me reconsider the error. \"can't find eyeball texture\". Maybe this is about the $Iris texture, not the material. Let me check whether the spy's rouge_eye.vtf is valid.",
  "Actually, let me reconsider. The medic's VMT references amy_eye as $Iris. The spy's references rouge_eye. Both exist as VTF in the custom folder.",
  "Hmm. Let me reconsider whether studiomdl actually searches the custom folder. The working char's material is only in the custom folder, and it compiles. So studiomdl DOES search the custom folder.",
  "So the spy's material should be found too. Unless the spy's material is somehow not in the search path.",
  "Wait — maybe the issue is that the custom folder search path in studiomdl requires the folder to be named a specific way, OR the material path resolution is different.",
  "Actually, let me reconsider the whole thing. Let me check the gameinfo.txt to understand the search path. Maybe the custom folder is NOT in the search path, and the working chars' materials are found via a different mechanism.",
  "Wait, but I checked tf/materials/console/models/player and it doesn't exist. So the working chars' materials are NOT in the base folder.",
  "Hmm, unless the working chars' materials are in the base folder under a DIFFERENT path. Let me search the entire tf folder for the working char's material.",
  "Actually, let me search the entire tf folder for blaze_eye_R.vmt (the working char's material). I already did that — it's only in the custom folder.",
  "So studiomdl searches the custom folder. And the spy's material is in the custom folder. So why does spy fail?",
].join("\n\n");

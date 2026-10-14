import { ArrayNotEmpty, IsArray, IsInt, Max, Min } from 'class-validator';
import { MAX_PART_COUNT } from '../videos.constants';

export class CreatePartsDto {
  /**
   * Part numbers to presign. The client asks only for the parts it is about to
   * upload, so a resumed upload requests just the parts still missing.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_PART_COUNT, { each: true })
  part_numbers: number[];
}

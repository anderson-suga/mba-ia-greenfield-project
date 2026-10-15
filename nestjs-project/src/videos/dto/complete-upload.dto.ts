import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_PART_COUNT } from '../videos.constants';

export class CompletedPartDto {
  /** 1-based part number, as returned when the part URL was presigned. */
  @IsInt()
  @Min(1)
  @Max(MAX_PART_COUNT)
  part_number: number;

  /** ETag returned by storage when the part was uploaded. */
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  /**
   * Every part that was uploaded, with its ETag. Storage validates the list and
   * rejects it if a part is missing, which surfaces as `422 UPLOAD_INCOMPLETE`.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
